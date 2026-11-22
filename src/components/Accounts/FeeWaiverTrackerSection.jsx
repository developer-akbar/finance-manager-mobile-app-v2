/**
 * FeeWaiverTrackerSection.jsx — Unified Credit Card Overview & Fee Waiver Tracker
 *
 * Implements a unified credit card overview rendering each card exactly once with:
 * A. Billing & Grace Period (cycle date, next statement, due date, grace period days)
 * B. Annual Fee & Waiver (lifetime free, fixed fee, threshold waiver progress, run-rate analytics)
 *
 * Features:
 * - Default collapsed transaction audit breakdown
 * - Automatic transfer eligibility for card-funded transfers
 * - Reversible manual eligibility overrides (Mark Eligible, Exclude, Reset) keyed by cardId and txnId
 * - Safeguards preventing override of hard exclusions (bill payments and reversals)
 * - Exact reconciled net spending formula matching engine calculations
 * - Clean responsive layout
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { formatINR, formatINRCompact } from '../../utils/format.js';
import {
  FEE_STRUCTURE,
  PERIOD_TYPE,
  WAIVER_STATUS,
  CLASSIFICATION_TYPE,
  resolveQualificationPeriod,
  calculateFeeWaiverProgress,
  isTransactionForCard,
  isHardExclusion,
} from '../../utils/feeWaiverEngine.js';
import {
  getFeeWaiverConfigs,
  getFeeWaiverHistory,
  getFeeWaiverOverrides,
  saveFeeWaiverOverride,
  saveFeeWaiverCycleOutcome,
} from '../../utils/feeWaiverStorage.js';
import CreditCardFeeWaiverModal from './CreditCardFeeWaiverModal.jsx';
import './FeeWaiverTrackerSection.css';

export default function FeeWaiverTrackerSection({
  accounts = [],
  transactions = [],
}) {
  const [configs, setConfigs] = useState({});
  const [history, setHistory] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [expandedCards, setExpandedCards] = useState({});
  const [activeTabPerCard, setActiveTabPerCard] = useState({});
  const [activeModalCard, setActiveModalCard] = useState(null);
  const [confirmingCardCycle, setConfirmingCardCycle] = useState(null);
  const [bankOutcomeChoice, setBankOutcomeChoice] = useState('WAIVED');
  const [bankOutcomeNotes, setBankOutcomeNotes] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const [cfgs, hist, ovrs] = await Promise.all([
        getFeeWaiverConfigs(),
        getFeeWaiverHistory(),
        getFeeWaiverOverrides(),
      ]);
      setConfigs(cfgs || {});
      setHistory(hist || []);
      setOverrides(ovrs || {});
    } catch (err) {
      console.error('Failed to load fee waiver configs/history/overrides:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleExpand = (cardKey) => {
    setExpandedCards(p => ({ ...p, [cardKey]: !p[cardKey] }));
  };

  const setCardTab = (cardKey, tab) => {
    setActiveTabPerCard(p => ({ ...p, [cardKey]: tab }));
  };

  const handleOverride = async (cardId, txnId, action) => {
    try {
      await saveFeeWaiverOverride(cardId, txnId, action);
      await loadData();
    } catch (err) {
      console.error('Failed to save manual override:', err);
    }
  };

  // Evaluate combined Billing + Fee Waiver progress for every credit card
  const evaluatedCards = useMemo(() => {
    const today = new Date();
    const result = [];

    for (const card of accounts) {
      const cardId = String(card.id || card.name || '').trim();
      const cardName = card.name || card;

      // ── A. Billing & Grace Period Calculation ──
      const stmtDay = card.settlementDate || 1;
      const dueDays = card.paymentDueDays || 20;

      const thisMonthStmt = new Date(today.getFullYear(), today.getMonth(), stmtDay);
      const nextStmtDate = today.getDate() < stmtDay
        ? thisMonthStmt
        : new Date(today.getFullYear(), today.getMonth() + 1, stmtDay);

      const nextDueDate = new Date(nextStmtDate.getFullYear(), nextStmtDate.getMonth(), nextStmtDate.getDate() + dueDays);
      const diffMs = nextDueDate.getTime() - today.getTime();
      const graceDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

      const billingInfo = {
        stmtDay,
        dueDays,
        nextStmtDate,
        nextDueDate,
        graceDays,
      };

      // ── B. Annual Fee Waiver Calculation ──
      const config = configs[cardId] || configs[cardName] || null;

      if (!config) {
        result.push({
          card,
          cardId,
          cardName,
          billingInfo,
          isConfigured: false,
        });
        continue;
      }

      const period = resolveQualificationPeriod({ config, referenceDate: today });
      const cardHistory = history.filter(h => String(h.cardId).trim() === cardId);
      const latestHistory = cardHistory.length > 0 ? cardHistory[cardHistory.length - 1] : null;

      // Filter transactions strictly to those associated with this specific card
      const cardTxns = (transactions || []).filter(t => isTransactionForCard(t, card));

      const cardOverrides = overrides[cardId] || {};

      const progress = calculateFeeWaiverProgress({
        card,
        config,
        period,
        transactions: cardTxns,
        referenceDate: today,
        bankOutcome: latestHistory?.bankOutcome || null,
        overrides: cardOverrides,
      });

      result.push({
        card,
        cardId,
        cardName,
        billingInfo,
        isConfigured: true,
        config,
        period,
        progress,
        history: cardHistory,
      });
    }

    return result;
  }, [accounts, configs, history, overrides, transactions]);

  const handleRecordBankOutcome = async (cardItem) => {
    if (!cardItem || !cardItem.progress || !cardItem.period) return;
    const progress = cardItem.progress;
    const period = cardItem.period;

    const outcome = {
      cardId: cardItem.cardId,
      periodStart: period.startDate ? period.startDate.toISOString().slice(0, 10) : '',
      periodEnd: period.endDate ? period.endDate.toISOString().slice(0, 10) : '',
      calculatedEligibleSpend: progress.netEligibleSpend,
      spendThreshold: progress.requiredThreshold,
      annualFee: progress.annualFee,
      targetReached: progress.netEligibleSpend >= progress.requiredThreshold,
      bankOutcome: bankOutcomeChoice,
      confirmationDate: new Date().toISOString().slice(0, 10),
      notes: bankOutcomeNotes.trim(),
    };

    await saveFeeWaiverCycleOutcome(outcome);
    setConfirmingCardCycle(null);
    setBankOutcomeNotes('');
    await loadData();
  };

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case WAIVER_STATUS.LIFETIME_FREE: return 'lifetime_free';
      case WAIVER_STATUS.TARGET_REACHED: return 'target_reached';
      case WAIVER_STATUS.TARGET_MISSED: return 'target_missed';
      case WAIVER_STATUS.PENDING_BANK_CONFIRMATION: return 'pending_bank_confirmation';
      case WAIVER_STATUS.BANK_CONFIRMED_WAIVED: return 'bank_confirmed_waived';
      case WAIVER_STATUS.BANK_CONFIRMED_CHARGED: return 'bank_confirmed_charged';
      default: return 'in_progress';
    }
  };

  const getTagClass = (classification) => {
    switch (classification) {
      case CLASSIFICATION_TYPE.ELIGIBLE_PURCHASE: return 'tag-purchase';
      case CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER: return 'tag-transfer';
      case CLASSIFICATION_TYPE.ELIGIBLE_REFUND: return 'tag-refund';
      case CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_TRANSFER:
      case CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_INCOME:
      case CLASSIFICATION_TYPE.UNKNOWN: return 'tag-ambiguous';
      default: return 'tag-excluded';
    }
  };

  const getTagLabel = (classification, reason) => {
    switch (classification) {
      case CLASSIFICATION_TYPE.ELIGIBLE_PURCHASE: return 'Eligible Purchase';
      case CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER: return 'Eligible Transfer';
      case CLASSIFICATION_TYPE.ELIGIBLE_REFUND: return 'Refund (Deducted)';
      case CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_TRANSFER:
      case CLASSIFICATION_TYPE.UNKNOWN: return 'Needs Review (Ambiguous Transfer)';
      case CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT: return 'Excluded (Bill Payment)';
      case CLASSIFICATION_TYPE.EXCLUDED_TRANSFER: return 'Excluded (Transfer Into Card)';
      case CLASSIFICATION_TYPE.EXCLUDED_INTEREST: return 'Excluded (Interest / Finance Charge)';
      case CLASSIFICATION_TYPE.EXCLUDED_ANNUAL_FEE: return 'Excluded (Annual Fee)';
      case CLASSIFICATION_TYPE.EXCLUDED_LATE_FEE: return 'Excluded (Late Fee)';
      case CLASSIFICATION_TYPE.EXCLUDED_CASH_WITHDRAWAL: return 'Excluded (Cash Advance / ATM)';
      case CLASSIFICATION_TYPE.EXCLUDED_REVERSAL: return 'Excluded (Reversal / Cancelled)';
      case CLASSIFICATION_TYPE.EXCLUDED_REWARDS_CASHBACK: return 'Excluded (Cashback / Rewards)';
      case CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_INCOME: return 'Excluded (Account Credit)';
      default: return reason || 'Excluded';
    }
  };

  return (
    <div className="fee-waiver-section">
      <div className="fee-waiver-section-hdr">
        <div className="fee-waiver-section-title">
          <span>💳</span> Credit Card Overview
        </div>
        {isRefreshing && (
          <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Updating...</span>
        )}
      </div>

      {evaluatedCards.length === 0 ? (
        <div className="fee-waiver-empty-card">
          <div style={{ fontSize: '1.2rem' }}>💳</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            No Credit Cards Found
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Add credit cards under Accounts or Settings to start tracking billing cycles and fee waivers.
          </div>
        </div>
      ) : (
        evaluatedCards.map(item => {
          const { card, cardId, cardName, billingInfo, isConfigured } = item;

          return (
            <div key={cardId} className="unified-card-container">
              {/* Card Header */}
              <div className="unified-card-header">
                <div>
                  <div className="unified-card-name">
                    <span>💳</span> {cardName}
                    {isConfigured && (
                      <span className={`fee-waiver-structure-badge ${
                        item.config.feeStructure === FEE_STRUCTURE.LIFETIME_FREE
                          ? 'ltf'
                          : item.config.feeStructure === FEE_STRUCTURE.FIXED_FEE
                          ? 'fixed'
                          : 'waiver'
                      }`}>
                        {item.config.feeStructure === FEE_STRUCTURE.LIFETIME_FREE
                          ? 'Lifetime Free'
                          : item.config.feeStructure === FEE_STRUCTURE.FIXED_FEE
                          ? 'Fixed Fee'
                          : 'Threshold Waiver'}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isConfigured ? (
                    <div className={`fee-waiver-status-badge ${getStatusBadgeClass(item.progress.status)}`}>
                      {item.progress.status === WAIVER_STATUS.TARGET_REACHED && '🎉 '}
                      {item.progress.status === WAIVER_STATUS.BANK_CONFIRMED_WAIVED && '✅ '}
                      {item.progress.status === WAIVER_STATUS.BANK_CONFIRMED_CHARGED && '❌ '}
                      {item.progress.status === WAIVER_STATUS.TARGET_MISSED && '⚠️ '}
                      {item.progress.statusLabel}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="fee-waiver-btn-secondary"
                      onClick={() => setActiveModalCard(card)}
                    >
                      ⚙️ Configure Waiver
                    </button>
                  )}
                </div>
              </div>

              {/* ── SECTION A: Billing & Grace Period ── */}
              <div className="unified-card-group billing-group">
                <div className="unified-card-group-title">
                  <span>📅</span> Billing &amp; Grace Period
                </div>
                <div className="unified-billing-grid">
                  <div className="unified-billing-item">
                    <span className="unified-item-lbl">Billing Cycle</span>
                    <span className="unified-item-val">{billingInfo.stmtDay}th of month</span>
                  </div>
                  <div className="unified-billing-item">
                    <span className="unified-item-lbl">Next Statement</span>
                    <span className="unified-item-val">
                      {billingInfo.nextStmtDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                  <div className="unified-billing-item">
                    <span className="unified-item-lbl">Payment Due</span>
                    <span className="unified-item-val">
                      {billingInfo.nextDueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                  <div className="unified-billing-item highlight">
                    <span className="unified-item-lbl">Grace Period</span>
                    <span className="unified-item-val grace-highlight">
                      {billingInfo.graceDays} Days
                    </span>
                  </div>
                </div>
              </div>

              {/* ── SECTION B: Annual Fee & Waiver ── */}
              <div className="unified-card-group waiver-group">
                <div className="unified-card-group-title">
                  <span>🎯</span> Annual Fee &amp; Waiver
                </div>

                {!isConfigured ? (
                  <div className="unified-unconfigured-row">
                    <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      Annual fee and waiver rules are not configured for this card.
                    </span>
                    <button
                      type="button"
                      className="fee-waiver-btn-secondary"
                      onClick={() => setActiveModalCard(card)}
                    >
                      ⚙️ Configure Waiver
                    </button>
                  </div>
                ) : item.config.feeStructure === FEE_STRUCTURE.LIFETIME_FREE ? (
                  <div className="unified-ltf-box">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: '1.1rem' }}>🎉</span>
                      <div>
                        <div style={{ fontWeight: 800, color: 'var(--green, #00e5a0)', fontSize: '0.85rem' }}>
                          Lifetime Free Credit Card
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          Annual Fee: ₹0 · No minimum spending requirement
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="fee-waiver-btn-secondary"
                      onClick={() => setActiveModalCard(card)}
                      style={{ marginLeft: 'auto' }}
                    >
                      ⚙️ Edit
                    </button>
                  </div>
                ) : item.config.feeStructure === FEE_STRUCTURE.FIXED_FEE ? (
                  <div className="unified-fixed-box">
                    <div>
                      <div style={{ fontWeight: 800, color: 'var(--text-primary)', fontSize: '0.85rem' }}>
                        Annual Fee: {formatINR(item.config.annualFee)}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Fixed membership fee (No spending waiver available)
                      </div>
                    </div>
                    <button
                      type="button"
                      className="fee-waiver-btn-secondary"
                      onClick={() => setActiveModalCard(card)}
                      style={{ marginLeft: 'auto' }}
                    >
                      ⚙️ Edit
                    </button>
                  </div>
                ) : (
                  // Threshold-Based Fee Waiver
                  <>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                      Fee: {formatINR(item.config.annualFee)} · Cycle: {item.period?.label || 'Current Period'}
                      {item.period?.startDateFormatted && item.period?.endDateFormatted ? (
                        ` (${item.period.startDateFormatted} – ${item.period.endDateFormatted})`
                      ) : null}
                    </div>

                    <div className="fee-waiver-progress-row">
                      <div className="fee-waiver-progress-bar-wrap">
                        <div
                          className="fee-waiver-progress-bar-fill"
                          style={{
                            width: `${item.progress.percentCompleted}%`,
                            background: item.progress.percentCompleted >= 100
                              ? 'var(--income, #00e5a0)'
                              : item.progress.status === WAIVER_STATUS.TARGET_MISSED
                              ? '#f87171'
                              : 'var(--accent, #0075FF)',
                          }}
                        />
                      </div>
                    </div>

                    <div className="fee-waiver-metrics-grid">
                      <div className="fee-waiver-metric">
                        <span className="fee-waiver-metric-label">Net Eligible Spend</span>
                        <span className="fee-waiver-metric-val green">
                          {formatINR(item.progress.netEligibleSpend)}
                        </span>
                      </div>

                      <div className="fee-waiver-metric">
                        <span className="fee-waiver-metric-label">Waiver Target</span>
                        <span className="fee-waiver-metric-val">
                          {formatINRCompact(item.progress.requiredThreshold)}
                        </span>
                      </div>

                      <div className="fee-waiver-metric">
                        <span className="fee-waiver-metric-label">Remaining Spend</span>
                        <span className={`fee-waiver-metric-val ${item.progress.amountRemaining === 0 ? 'green' : 'amber'}`}>
                          {item.progress.amountRemaining === 0 ? 'Target Met!' : formatINR(item.progress.amountRemaining)}
                        </span>
                      </div>

                      <div className="fee-waiver-metric">
                        <span className="fee-waiver-metric-label">Days Left</span>
                        <span className={`fee-waiver-metric-val ${item.progress.daysRemaining <= 15 && item.progress.amountRemaining > 0 ? 'red' : ''}`}>
                          {item.progress.daysRemaining} days
                        </span>
                      </div>

                      {item.progress.amountRemaining > 0 && item.progress.daysRemaining > 0 && (
                        <div className="fee-waiver-metric" style={{ gridColumn: 'span 2' }}>
                          <span className="fee-waiver-metric-label">Required Monthly Spend</span>
                          <span className="fee-waiver-metric-val" style={{ color: 'var(--text-secondary, #cbd5e1)' }}>
                            ~{formatINR(item.progress.avgMonthlySpendRequired)} / month
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Actions row: Toggle breakdown & Bank Confirmation */}
                    <div className="fee-waiver-actions-row">
                      <button
                        type="button"
                        className="fee-waiver-btn-toggle"
                        onClick={() => toggleExpand(cardId)}
                      >
                        {expandedCards[cardId] ? '▲ Hide Calculations & Transactions' : '▼ View Calculations & Transactions'}
                      </button>

                      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                        <button
                          type="button"
                          className="fee-waiver-btn-secondary"
                          onClick={() => setConfirmingCardCycle(item)}
                          title="Record bank's official waiver or fee charging decision"
                        >
                          🏛️ Record Bank Outcome
                        </button>
                        <button
                          type="button"
                          className="fee-waiver-btn-secondary"
                          onClick={() => setActiveModalCard(card)}
                        >
                          ⚙️ Edit Settings
                        </button>
                      </div>
                    </div>

                    {/* ── Expanded Breakdown Drawer ── */}
                    {expandedCards[cardId] && (
                      <div className="fee-waiver-breakdown-panel">
                        {/* Summary reconciliation formula */}
                        {(() => {
                          const allTxns = item.progress.classifiedTransactions || [];
                          const purchases = allTxns.filter(ct => ct.classification === CLASSIFICATION_TYPE.ELIGIBLE_PURCHASE);
                          const transfers = allTxns.filter(ct => ct.classification === CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER);
                          const refunds = allTxns.filter(ct => ct.classification === CLASSIFICATION_TYPE.ELIGIBLE_REFUND);
                          const ambiguous = allTxns.filter(ct =>
                            ct.classification === CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_TRANSFER ||
                            ct.classification === CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_INCOME ||
                            ct.classification === CLASSIFICATION_TYPE.UNKNOWN
                          );
                          const excluded = allTxns.filter(ct =>
                            !ct.isEligible &&
                            ct.classification !== CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_TRANSFER &&
                            ct.classification !== CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_INCOME &&
                            ct.classification !== CLASSIFICATION_TYPE.UNKNOWN &&
                            ct.classification !== CLASSIFICATION_TYPE.EXCLUDED_NON_CARD
                          );

                          const activeTab = activeTabPerCard[cardId] || 'all';
                          let displayedTxns = allTxns;
                          if (activeTab === 'purchases') displayedTxns = purchases;
                          else if (activeTab === 'transfers') displayedTxns = transfers;
                          else if (activeTab === 'refunds') displayedTxns = refunds;
                          else if (activeTab === 'ambiguous') displayedTxns = ambiguous;
                          else if (activeTab === 'excluded') displayedTxns = excluded;

                          return (
                            <>
                              <div className="fee-waiver-formula-card">
                                <div className="fee-waiver-formula-title">Reconciled Net Spending Formula</div>
                                <div className="fee-waiver-formula-row">
                                  <div className="fee-waiver-formula-col">
                                    <span className="fee-waiver-formula-lbl">Purchases ({purchases.length})</span>
                                    <span className="fee-waiver-formula-val pos">+{formatINR(item.progress.eligiblePurchaseTotal)}</span>
                                  </div>
                                  <span className="fee-waiver-formula-op">+</span>
                                  <div className="fee-waiver-formula-col">
                                    <span className="fee-waiver-formula-lbl">Transfers ({transfers.length})</span>
                                    <span className="fee-waiver-formula-val pos">+{formatINR(item.progress.eligibleTransferTotal)}</span>
                                  </div>
                                  <span className="fee-waiver-formula-op">−</span>
                                  <div className="fee-waiver-formula-col">
                                    <span className="fee-waiver-formula-lbl">Refunds ({refunds.length})</span>
                                    <span className="fee-waiver-formula-val neg">−{formatINR(item.progress.eligibleRefundTotal)}</span>
                                  </div>
                                  <span className="fee-waiver-formula-op">=</span>
                                  <div className="fee-waiver-formula-col total">
                                    <span className="fee-waiver-formula-lbl">Net Eligible Spend</span>
                                    <span className="fee-waiver-formula-val total">{formatINR(item.progress.netEligibleSpend)}</span>
                                  </div>
                                </div>
                              </div>

                              {/* Ambiguous items requiring review */}
                              {item.progress.ambiguousCount > 0 && (
                                <div className="fee-waiver-ambiguous-box">
                                  ⚠️ <strong>{item.progress.ambiguousCount} unclassified transaction(s) require review.</strong>
                                  <div style={{ marginTop: 4, fontSize: '0.68rem' }}>
                                    Review these items below and click <strong>Mark Eligible</strong> or <strong>Exclude</strong> to override.
                                  </div>
                                </div>
                              )}

                              {/* Category Filter Tabs */}
                              <div className="fee-waiver-tab-pills">
                                <button
                                  type="button"
                                  className={`fee-waiver-tab-pill ${activeTab === 'all' ? 'active' : ''}`}
                                  onClick={() => setCardTab(cardId, 'all')}
                                >
                                  All ({allTxns.length})
                                </button>
                                <button
                                  type="button"
                                  className={`fee-waiver-tab-pill ${activeTab === 'purchases' ? 'active' : ''}`}
                                  onClick={() => setCardTab(cardId, 'purchases')}
                                >
                                  Purchases ({purchases.length})
                                </button>
                                {transfers.length > 0 && (
                                  <button
                                    type="button"
                                    className={`fee-waiver-tab-pill ${activeTab === 'transfers' ? 'active' : ''}`}
                                    onClick={() => setCardTab(cardId, 'transfers')}
                                  >
                                    Transfers ({transfers.length})
                                  </button>
                                )}
                                {refunds.length > 0 && (
                                  <button
                                    type="button"
                                    className={`fee-waiver-tab-pill ${activeTab === 'refunds' ? 'active' : ''}`}
                                    onClick={() => setCardTab(cardId, 'refunds')}
                                  >
                                    Refunds ({refunds.length})
                                  </button>
                                )}
                                {ambiguous.length > 0 && (
                                  <button
                                    type="button"
                                    className={`fee-waiver-tab-pill warning ${activeTab === 'ambiguous' ? 'active' : ''}`}
                                    onClick={() => setCardTab(cardId, 'ambiguous')}
                                  >
                                    Needs Review ({ambiguous.length})
                                  </button>
                                )}
                                {excluded.length > 0 && (
                                  <button
                                    type="button"
                                    className={`fee-waiver-tab-pill ${activeTab === 'excluded' ? 'active' : ''}`}
                                    onClick={() => setCardTab(cardId, 'excluded')}
                                  >
                                    Excluded ({excluded.length})
                                  </button>
                                )}
                              </div>

                              {/* Filtered Transactions List */}
                              <div className="fee-waiver-breakdown-group">
                                <div className="fee-waiver-breakdown-hdr">
                                  <span>Card Transactions ({displayedTxns.length})</span>
                                  <span style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>
                                    Showing transactions for {cardName} only
                                  </span>
                                </div>

                                {displayedTxns.length === 0 ? (
                                  <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                                    No transactions found in this category.
                                  </div>
                                ) : (
                                  <div className="fee-waiver-txn-list-scroll">
                                    {displayedTxns.map((ct, idx) => {
                                      const txnId = ct.txn._id || ct.txn.id || ct.txn.ID;
                                      const isHardExcl = isHardExclusion(ct.classification);
                                      const rawDesc = String(ct.txn.Description || ct.txn.description || '').trim();
                                      const rawNote = String(ct.txn.Note || ct.txn.note || ct.txn.Notes || ct.txn.notes || '').trim();
                                      const displayTitle = rawDesc || ct.txn.Merchant || ct.txn.Category || 'Card Transaction';

                                      return (
                                        <div key={idx} className="fee-waiver-txn-item">
                                          <div className="fee-waiver-txn-desc">
                                            {/* Notes Line (Rendered first, only if Notes field is present and non-empty) */}
                                            {rawNote ? (
                                              <div className="fee-waiver-note-line">
                                                <span className="fee-waiver-field-tag note-tag">NOTE</span>
                                                <span className="fee-waiver-note-text">{rawNote}</span>
                                              </div>
                                            ) : null}

                                            {/* Description Line (Rendered below Note) */}
                                            <div className="fee-waiver-desc-line">
                                              <span className="fee-waiver-field-tag desc-tag">DESCRIPTION</span>
                                              <span className="fee-waiver-desc-text">{displayTitle}</span>
                                              {ct.isManualOverride && (
                                                <span className="fee-waiver-override-badge">
                                                  Override: {ct.manualOverride === 'ELIGIBLE' ? 'Eligible' : 'Excluded'}
                                                </span>
                                              )}
                                            </div>

                                            {/* Transaction Meta Line */}
                                            <div className="fee-waiver-txn-meta">
                                              <span>{ct.txn.Date}</span>
                                              {ct.txn['Income/Expense'] && <span> · {ct.txn['Income/Expense']}</span>}
                                              {ct.txn.Category && <span> · {ct.txn.Category}</span>}
                                              {ct.txn.Subcategory && <span> › {ct.txn.Subcategory}</span>}
                                            </div>
                                          </div>

                                          <div className="fee-waiver-txn-amt-col">
                                            <span
                                              className={`fee-waiver-txn-amt ${
                                                ct.classification === CLASSIFICATION_TYPE.ELIGIBLE_REFUND
                                                  ? 'neg'
                                                  : ct.isEligible
                                                  ? 'pos'
                                                  : 'excluded'
                                              }`}
                                            >
                                              {ct.classification === CLASSIFICATION_TYPE.ELIGIBLE_REFUND
                                                ? '−'
                                                : ct.isEligible
                                                ? '+'
                                                : ''}
                                              {formatINR(ct.amount)}
                                            </span>
                                            <span className={`fee-waiver-txn-tag ${getTagClass(ct.classification)}`}>
                                              {getTagLabel(ct.classification, ct.reason)}
                                            </span>

                                            {/* Manual Override Action Buttons */}
                                            <div className="fee-waiver-override-actions">
                                              {ct.isManualOverride ? (
                                                <button
                                                  type="button"
                                                  className="fee-waiver-override-btn reset"
                                                  onClick={() => handleOverride(cardId, txnId, 'RESET')}
                                                  title="Reset to automatic classification"
                                                >
                                                  ↩ Reset
                                                </button>
                                              ) : (
                                                <>
                                                  {ct.isEligible ? (
                                                    <button
                                                      type="button"
                                                      className="fee-waiver-override-btn exclude"
                                                      onClick={() => handleOverride(cardId, txnId, 'EXCLUDED')}
                                                      title="Exclude from fee waiver spending"
                                                    >
                                                      ✕ Exclude
                                                    </button>
                                                  ) : isHardExcl ? (
                                                    <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>
                                                      Locked
                                                    </span>
                                                  ) : (
                                                    <button
                                                      type="button"
                                                      className="fee-waiver-override-btn include"
                                                      onClick={() => handleOverride(cardId, txnId, 'ELIGIBLE')}
                                                      title="Mark as eligible spending"
                                                    >
                                                      ✓ Mark Eligible
                                                    </button>
                                                  )}
                                                </>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Historical Finalized Cycles */}
              {item.history && item.history.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                    Historical Finalized Cycles ({item.history.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {item.history.map((h, hIdx) => (
                      <div
                        key={hIdx}
                        style={{
                          fontSize: '0.72rem',
                          padding: '6px 10px',
                          borderRadius: 8,
                          background: 'var(--bg-card2)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <div>
                          <strong>{h.periodStart} – {h.periodEnd}</strong>
                          <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>
                            Spent: {formatINR(h.calculatedEligibleSpend)} / {formatINR(h.spendThreshold)}
                            {h.notes ? ` · Note: ${h.notes}` : ''}
                          </div>
                        </div>
                        <span
                          className={`fee-waiver-status-badge ${
                            h.bankOutcome === 'WAIVED'
                              ? 'bank_confirmed_waived'
                              : h.bankOutcome === 'CHARGED'
                              ? 'bank_confirmed_charged'
                              : 'pending_bank_confirmation'
                          }`}
                          style={{ fontSize: '0.64rem', padding: '2px 8px' }}
                        >
                          {h.bankOutcome === 'WAIVED' ? '✅ Waived' : h.bankOutcome === 'CHARGED' ? '❌ Charged' : '⏳ Pending'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Record Bank Outcome Modal */}
      {confirmingCardCycle && (
        <>
          <div className="overlay" onClick={() => setConfirmingCardCycle(null)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 20px)' }}>
            <div className="sheet-handle" />
            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>
              Record Bank Waiver Decision
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              Record the bank's official annual fee waiver outcome for {confirmingCardCycle.cardName}.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label className="form-label" style={{ marginBottom: 6, display: 'block' }}>Official Outcome</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  <button
                    type="button"
                    className={`btn ${bankOutcomeChoice === 'WAIVED' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.72rem', padding: '8px 4px' }}
                    onClick={() => setBankOutcomeChoice('WAIVED')}
                  >
                    ✅ Waived
                  </button>
                  <button
                    type="button"
                    className={`btn ${bankOutcomeChoice === 'CHARGED' ? 'btn-danger' : 'btn-secondary'}`}
                    style={{ fontSize: '0.72rem', padding: '8px 4px' }}
                    onClick={() => setBankOutcomeChoice('CHARGED')}
                  >
                    ❌ Charged
                  </button>
                  <button
                    type="button"
                    className={`btn ${bankOutcomeChoice === 'PENDING' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.72rem', padding: '8px 4px' }}
                    onClick={() => setBankOutcomeChoice('PENDING')}
                  >
                    ⏳ Pending
                  </button>
                </div>
              </div>

              <div>
                <label className="form-label" style={{ marginBottom: 4, display: 'block' }}>Notes (Optional)</label>
                <textarea
                  className="form-input"
                  rows={2}
                  value={bankOutcomeNotes}
                  onChange={e => setBankOutcomeNotes(e.target.value)}
                  placeholder="e.g. Called customer care on 15 May; waiver approved under spending milestone"
                  style={{ width: '100%', resize: 'none' }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setConfirmingCardCycle(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => handleRecordBankOutcome(confirmingCardCycle)}
                >
                  Save Outcome
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Edit Configuration Modal */}
      {activeModalCard && (
        <CreditCardFeeWaiverModal
          card={activeModalCard}
          isOpen={!!activeModalCard}
          onClose={() => setActiveModalCard(null)}
          onSaved={loadData}
        />
      )}
    </div>
  );
}
