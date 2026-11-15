import React, { useState } from 'react';
import { formatINR, formatINRCompact } from '../../utils/format.js';

const getTxnIcon = (t) => {
  if (t.type === 'income') return '💰';
  if (t.type === 'transfer') return '🔄';
  const c = String(t.category || '').toLowerCase();
  if (c.includes('food') || c.includes('dining')) return '🍔';
  if (c.includes('grocer')) return '🛒';
  if (c.includes('fuel') || c.includes('petrol')) return '⛽';
  if (c.includes('travel') || c.includes('flight')) return '✈️';
  if (c.includes('shop')) return '🛍️';
  if (c.includes('bill') || c.includes('recharge')) return '⚡';
  if (c.includes('invest')) return '📈';
  return '💸';
};

export default function DashboardRecentActivity({
  analytics,
  showPrivacy,
  dueAlerts = [],
  onPayDueAlert,
  onDismissDueAlert,
  onNavigateTransactions,
  onNavigateSettings,
}) {
  const [activeTab, setActiveTab] = useState('timeline'); // 'timeline' | 'upcoming' | 'alerts'
  const { activityAndAlerts } = analytics;
  const {
    recentTxns = [],
    upcomingScheduledTxns = [],
    largeTxns = [],
    unusualAlerts = [],
    upcomingRecurring = [],
  } = activityAndAlerts;

  const totalAlertsCount = dueAlerts.length + unusualAlerts.length + (largeTxns.length > 0 ? 1 : 0);

  return (
    <div className="dash-bento-card dash-activity-bento-card">
      <div className="dash-card-header-compact">
        <div className="dash-card-title-group">
          <div className="dash-bento-card-title">Activity & Intelligence</div>
          <div className="dash-bento-card-sub">
            {activeTab === 'timeline' && 'Completed historical activity up to today'}
            {activeTab === 'upcoming' && 'Scheduled & post-dated future transactions'}
            {activeTab === 'alerts' && 'Smart spending & payment alerts'}
          </div>
        </div>

        {/* Tab switchers */}
        <div className="dash-pill-toggle-group">
          <button
            type="button"
            className={`dash-pill-btn ${activeTab === 'timeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('timeline')}
          >
            Timeline
          </button>
          {upcomingScheduledTxns.length > 0 && (
            <button
              type="button"
              className={`dash-pill-btn ${activeTab === 'upcoming' ? 'active' : ''}`}
              onClick={() => setActiveTab('upcoming')}
            >
              Upcoming
              <span className="dash-alert-counter-badge upcoming">{upcomingScheduledTxns.length}</span>
            </button>
          )}
          <button
            type="button"
            className={`dash-pill-btn ${activeTab === 'alerts' ? 'active' : ''}`}
            onClick={() => setActiveTab('alerts')}
          >
            Alerts
            {totalAlertsCount > 0 && (
              <span className="dash-alert-counter-badge">{totalAlertsCount}</span>
            )}
          </button>
        </div>
      </div>

      <div className="dash-activity-body">
        {/* ── TAB 1: RECENT HISTORICAL TRANSACTIONS TIMELINE (<= today) ── */}
        {activeTab === 'timeline' && (
          <div className="dash-timeline-container">
            {recentTxns.length === 0 ? (
              <div className="dash-empty-state">No recent completed transactions recorded up to today.</div>
            ) : (
              recentTxns.map((t, idx) => {
                const icon = getTxnIcon(t);
                const isLast = idx === recentTxns.length - 1;
                return (
                  <div
                    key={t.id || idx}
                    className="dash-timeline-item clickable"
                    onClick={() => onNavigateTransactions?.()}
                  >
                    {/* Vertical Timeline Marker & Line */}
                    <div className="dash-timeline-marker-col">
                      <div
                        className="dash-timeline-dot"
                        style={{
                          background: t.type === 'income' ? '#01B574' : t.type === 'transfer' ? '#00D2D3' : '#EE5D50',
                          boxShadow: `0 0 10px ${t.type === 'income' ? 'rgba(1, 181, 116, 0.4)' : t.type === 'transfer' ? 'rgba(0, 210, 211, 0.4)' : 'rgba(238, 93, 80, 0.4)'}`,
                        }}
                      >
                        <span className="dash-timeline-icon">{icon}</span>
                      </div>
                      {!isLast && <div className="dash-timeline-line" />}
                    </div>

                    {/* Timeline Content */}
                    <div className="dash-timeline-content">
                      <div className="dash-timeline-top">
                        <span className="dash-timeline-note">
                          {t.note || t.category || 'Transaction'}
                        </span>
                        <span
                          className={`dash-timeline-amt ${t.type === 'income' ? 'income' : t.type === 'transfer' ? 'transfer' : 'expense'}`}
                        >
                          {t.type === 'income' ? '+' : t.type === 'expense' ? '−' : ''}
                          {showPrivacy ? formatINR(t.amount) : '••••'}
                        </span>
                      </div>
                      <div className="dash-timeline-sub">
                        <span>{t.date}</span> · <span>{t.category}</span> {t.account ? `· ${t.account}` : ''}
                        {t.toAccount ? ` → ${t.toAccount}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            <div className="dash-timeline-footer">
              <button
                type="button"
                className="dash-link-action-btn"
                onClick={() => onNavigateTransactions?.()}
              >
                View Full Transaction Ledger →
              </button>
            </div>
          </div>
        )}

        {/* ── TAB 2: UPCOMING / SCHEDULED TRANSACTIONS (> today) ── */}
        {activeTab === 'upcoming' && (
          <div className="dash-upcoming-tab-content">
            <div className="dash-upcoming-notice">
              <span className="dash-upcoming-notice-icon">📅</span>
              <div className="dash-upcoming-notice-text">
                <strong>Future & Instalment Records:</strong> These transactions are dated after today and do not affect current monthly spending or realized deficit.
              </div>
            </div>

            <div className="dash-timeline-container">
              {upcomingScheduledTxns.map((t, idx) => {
                const isLast = idx === upcomingScheduledTxns.length - 1;
                return (
                  <div
                    key={t.id || idx}
                    className="dash-timeline-item clickable"
                    onClick={() => onNavigateTransactions?.()}
                  >
                    <div className="dash-timeline-marker-col">
                      <div
                        className="dash-timeline-dot scheduled"
                        style={{
                          background: '#0075FF',
                          boxShadow: '0 0 10px rgba(0, 117, 255, 0.4)',
                        }}
                      >
                        <span className="dash-timeline-icon">⏳</span>
                      </div>
                      {!isLast && <div className="dash-timeline-line" />}
                    </div>

                    <div className="dash-timeline-content">
                      <div className="dash-timeline-top">
                        <div className="dash-upcoming-title-wrap">
                          <span className="dash-timeline-note">
                            {t.note || t.category || 'Scheduled Transaction'}
                          </span>
                          <span className="dash-inv-badge cost">Scheduled</span>
                        </div>
                        <span className="dash-timeline-amt neutral">
                          {showPrivacy ? formatINR(t.amount) : '••••'}
                        </span>
                      </div>
                      <div className="dash-timeline-sub">
                        <span>Scheduled: <strong>{t.date}</strong></span> · <span>{t.category}</span> {t.account ? `· ${t.account}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── TAB 3: SMART ALERTS & UPCOMING BILLS ── */}
        {activeTab === 'alerts' && (
          <div className="dash-alerts-tab-content">
            {/* 1. Credit Card Due Alerts */}
            {dueAlerts.length > 0 && (
              <div className="dash-alert-group">
                <div className="dash-alert-group-title">Credit Card Dues</div>
                {dueAlerts.map(alert => (
                  <div key={alert.acct.name} className="dash-smart-alert-card due">
                    <div className="dash-alert-icon-box">💳</div>
                    <div className="dash-alert-text-box">
                      <div className="dash-alert-heading">
                        {alert.acct.name} due in {alert.days} days
                      </div>
                      <div className="dash-alert-desc">
                        {showPrivacy ? formatINR(alert.balancePayable) : '••••'} payable · Due {alert.due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      </div>
                    </div>
                    <div className="dash-alert-actions">
                      <button
                        type="button"
                        className="dash-alert-pill-btn pay"
                        onClick={() => onPayDueAlert?.(alert.acct.name)}
                      >
                        Pay
                      </button>
                      <button
                        type="button"
                        className="dash-alert-pill-btn dismiss"
                        onClick={() => onDismissDueAlert?.(alert.acct.name)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 2. Unusual Spending Warnings */}
            {unusualAlerts.length > 0 && (
              <div className="dash-alert-group">
                <div className="dash-alert-group-title">Spending Surge Warnings</div>
                {unusualAlerts.map(alert => (
                  <div key={alert.category} className="dash-smart-alert-card warning">
                    <div className="dash-alert-icon-box warning">⚠️</div>
                    <div className="dash-alert-text-box">
                      <div className="dash-alert-heading">
                        {alert.category} spend is {alert.pctSurge}% above normal
                      </div>
                      <div className="dash-alert-desc">
                        Current: <strong>{showPrivacy ? formatINR(alert.currentAmount) : '••••'}</strong> vs 3-mo avg {showPrivacy ? formatINR(alert.normalAverage) : '••••'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 3. Large Transaction Highlights */}
            {largeTxns.length > 0 && (
              <div className="dash-alert-group">
                <div className="dash-alert-group-title">Major Expenses This Month (≥ ₹10k)</div>
                {largeTxns.map(t => (
                  <div key={t.id} className="dash-smart-alert-card info">
                    <div className="dash-alert-icon-box info">💎</div>
                    <div className="dash-alert-text-box">
                      <div className="dash-alert-heading">{t.note}</div>
                      <div className="dash-alert-desc">
                        {t.date} · {t.category}
                      </div>
                    </div>
                    <div className="dash-alert-side-val expense">
                      {showPrivacy ? formatINR(t.amount) : '••••'}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 4. Upcoming Recurring Bills */}
            {upcomingRecurring.length > 0 && (
              <div className="dash-alert-group">
                <div className="dash-alert-group-title">Upcoming Recurring Rules</div>
                {upcomingRecurring.map(rule => (
                  <div key={rule.id} className="dash-smart-alert-card recurring">
                    <div className="dash-alert-icon-box recurring">🔄</div>
                    <div className="dash-alert-text-box">
                      <div className="dash-alert-heading">{rule.note}</div>
                      <div className="dash-alert-desc">
                        {rule.frequency} · Next: {rule.nextDate || 'Upcoming'}
                      </div>
                    </div>
                    <div className="dash-alert-side-val">
                      {showPrivacy ? formatINR(rule.amount) : '••••'}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {totalAlertsCount === 0 && upcomingRecurring.length === 0 && (
              <div className="dash-empty-state">
                No active alerts. All credit cards and spending categories are well within limits!
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
