import React from 'react';
import { formatINR, formatINRCompact } from '../../utils/format.js';

export default function DashboardDebtCards({
  analytics,
  showPrivacy,
  onOpenDebtTracker,
  onOpenAccounts,
}) {
  const { debt, creditCards } = analytics;
  const { totalReceivables, totalPayables, counterpartiesCount, topCounterparties } = debt;
  const { cards, totalPayable } = creditCards;

  return (
    <div className="dash-bento-card dash-debt-bento-card">
      <div className="dash-card-header-compact">
        <div className="dash-card-title-group">
          <div className="dash-bento-card-title">Liabilities & Receivables</div>
          <div className="dash-bento-card-sub">Debts, loans & credit card billing</div>
        </div>
        <button
          type="button"
          className="dash-card-action-link"
          onClick={onOpenDebtTracker}
        >
          Debt Tracker →
        </button>
      </div>

      <div className="dash-debt-body">
        {/* Dual Pillar: Lent vs Borrowed */}
        <div className="dash-debt-hero-matrix">
          {/* Receivables: Money Lent */}
          <div className="dash-debt-box clickable" onClick={onOpenDebtTracker}>
            <div className="dash-debt-box-top">
              <span className="dash-debt-tag-pill green">To Receive</span>
              <span className="dash-debt-icon">🤝</span>
            </div>
            <div className="dash-debt-amount income">
              {showPrivacy ? formatINR(totalReceivables) : '₹ ••••'}
            </div>
            <div className="dash-debt-sub">
              {counterpartiesCount > 0 ? `${counterpartiesCount} people owe you` : 'No pending receivables'}
            </div>
          </div>

          {/* Payables: Money Borrowed */}
          <div className="dash-debt-box clickable" onClick={onOpenDebtTracker}>
            <div className="dash-debt-box-top">
              <span className="dash-debt-tag-pill red">To Repay</span>
              <span className="dash-debt-icon">⏳</span>
            </div>
            <div className="dash-debt-amount expense">
              {showPrivacy ? formatINR(totalPayables) : '₹ ••••'}
            </div>
            <div className="dash-debt-sub">
              {totalPayables > 0 ? 'Outstanding borrowing' : 'Zero debt payable'}
            </div>
          </div>
        </div>

        {/* Credit Card Dues Overview */}
        <div className="dash-cc-section">
          <div className="dash-cc-section-hdr">
            <div className="dash-cc-hdr-left">
              <span className="dash-cc-title">Credit Card Dues</span>
              <span className="dash-cc-total">
                Total Payable: <strong>{showPrivacy ? formatINR(totalPayable) : '••••'}</strong>
              </span>
            </div>
            <button
              type="button"
              className="dash-cc-manage-btn"
              onClick={() => onOpenAccounts?.('Credit Cards')}
            >
              Accounts →
            </button>
          </div>

          {cards.length === 0 ? (
            <div className="dash-empty-state-compact">No credit cards added.</div>
          ) : (
            <div className="dash-cc-list">
              {cards.map(card => {
                const isDueSoon = card.daysDue !== null && card.daysDue <= 7;
                return (
                  <div
                    key={card.name}
                    className="dash-cc-item clickable"
                    onClick={() => onOpenAccounts?.(card.name)}
                    title={`View ${card.name} transactions`}
                  >
                    <div className="dash-cc-left">
                      <span className="dash-cc-chip-icon">💳</span>
                      <div>
                        <div className="dash-cc-name">{card.name}</div>
                        <div className="dash-cc-due-text">
                          {card.daysDue !== null ? (
                            <span style={{ color: isDueSoon ? '#EE5D50' : 'var(--text-muted)' }}>
                              {card.daysDue < 0 ? 'Overdue!' : card.daysDue === 0 ? 'Due today!' : `Due in ${card.daysDue}d`}
                            </span>
                          ) : (
                            <span>Cycle open</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="dash-cc-right">
                      <div className="dash-cc-bill-val">
                        {showPrivacy ? formatINR(card.balancePayable) : '••••'}
                      </div>
                      <span className="dash-cc-action-pill">Pay →</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Active Counterparties Highlights */}
        {topCounterparties.length > 0 && (
          <div className="dash-debt-counterparties-wrap">
            <div className="dash-counterparties-hdr">Active Debt Records</div>
            <div className="dash-counterparties-chips">
              {topCounterparties.map(p => (
                <div
                  key={p.name}
                  className="dash-counterparty-chip clickable"
                  onClick={onOpenDebtTracker}
                >
                  <span className="dash-cp-name">{p.name}</span>
                  <span className={`dash-cp-amt ${p.type === 'lent' ? 'income' : 'expense'}`}>
                    {p.type === 'lent' ? '+' : '−'}{showPrivacy ? formatINRCompact(p.amount) : '••••'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

