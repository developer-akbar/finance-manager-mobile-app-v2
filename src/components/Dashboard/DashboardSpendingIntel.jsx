import React, { useState } from 'react';
import { formatINR, formatINRCompact } from '../../utils/format.js';

const getCategoryEmoji = (category) => {
  const c = String(category || '').toLowerCase();
  if (c.includes('food') || c.includes('dining') || c.includes('restaurant') || c.includes('swiggy') || c.includes('zomato')) return '🍔';
  if (c.includes('grocer') || c.includes('supermarket') || c.includes('dmart')) return '🛒';
  if (c.includes('fuel') || c.includes('petrol') || c.includes('diesel')) return '⛽';
  if (c.includes('travel') || c.includes('flight') || c.includes('train') || c.includes('uber') || c.includes('cab')) return '✈️';
  if (c.includes('shop') || c.includes('cloth') || c.includes('amazon') || c.includes('myntra')) return '🛍️';
  if (c.includes('health') || c.includes('medic') || c.includes('doctor') || c.includes('hospital')) return '💊';
  if (c.includes('bill') || c.includes('electric') || c.includes('water') || c.includes('utility') || c.includes('wifi') || c.includes('recharge')) return '⚡';
  if (c.includes('house') || c.includes('rent') || c.includes('home') || c.includes('maintenance')) return '🏠';
  if (c.includes('entertain') || c.includes('movie') || c.includes('ott') || c.includes('netflix')) return '🎬';
  if (c.includes('education') || c.includes('school') || c.includes('course') || c.includes('book')) return '📚';
  if (c.includes('invest') || c.includes('stock') || c.includes('mutual')) return '📈';
  if (c.includes('insur')) return '🛡️';
  if (c.includes('personal') || c.includes('salon') || c.includes('groom')) return '✂️';
  if (c.includes('gift') || c.includes('donation')) return '🎁';
  return '📦';
};

export default function DashboardSpendingIntel({ analytics, showPrivacy, onNavigateCategories, onNavigateTransactions }) {
  const [activeTab, setActiveTab] = useState('categories'); // 'categories' | 'spikes' | 'highest' | 'history'
  const { spending } = analytics;
  const { topCategories, spikes, highestExpenses, historical, budgets } = spending;

  return (
    <div className="dash-bento-card dash-spending-intel-card">
      <div className="dash-spending-card-header">
        <div className="dash-spending-title-wrap">
          <div className="dash-bento-card-title">Spending Intelligence</div>
          <div className="dash-bento-card-sub">Category analysis, outliers & budgets</div>
        </div>

        {/* Tab switchers */}
        <div className="dash-pill-toggle-group">
          <button
            type="button"
            className={`dash-pill-btn ${activeTab === 'categories' ? 'active' : ''}`}
            onClick={() => setActiveTab('categories')}
          >
            Top Categories
          </button>
          <button
            type="button"
            className={`dash-pill-btn ${activeTab === 'spikes' ? 'active' : ''}`}
            onClick={() => setActiveTab('spikes')}
          >
            MoM Spikes
          </button>
          <button
            type="button"
            className={`dash-pill-btn ${activeTab === 'highest' ? 'active' : ''}`}
            onClick={() => setActiveTab('highest')}
          >
            Highest
          </button>
          <button
            type="button"
            className={`dash-pill-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            History
          </button>
        </div>
      </div>

      <div className="dash-spending-content">
        {/* ── TAB 1: TOP CATEGORIES WITH PROGRESS BARS ── */}
        {activeTab === 'categories' && (
          <div className="dash-top-categories-list">
            {topCategories.length === 0 ? (
              <div className="dash-empty-state">No expense recorded in the current period.</div>
            ) : (
              topCategories.slice(0, 5).map((cat, idx) => {
                const emoji = getCategoryEmoji(cat.category);
                const isIncreased = cat.diff > 0;
                return (
                  <div
                    key={cat.category}
                    className="dash-category-progress-row clickable"
                    onClick={() => onNavigateCategories?.(cat.category)}
                    title={`View ${cat.category} transactions`}
                  >
                    <div className="dash-cat-icon-col">{emoji}</div>
                    <div className="dash-cat-body-col">
                      <div className="dash-cat-label-row">
                        <span className="dash-cat-name">{cat.category}</span>
                        <div className="dash-cat-right-values">
                          <span className="dash-cat-amount">
                            {showPrivacy ? formatINR(cat.amount) : '••••'}
                          </span>
                          <span className="dash-cat-pct-badge">{cat.pctOfTotal}%</span>
                        </div>
                      </div>

                      {/* Progress Bar Track */}
                      <div className="dash-cat-progress-track">
                        <div
                          className="dash-cat-progress-fill"
                          style={{
                            width: `${Math.min(100, Math.max(4, cat.pctOfTotal))}%`,
                            background: idx === 0 ? '#EE5D50' : idx === 1 ? '#0075FF' : idx === 2 ? '#00D2D3' : '#a0aec0',
                          }}
                        />
                      </div>

                      {/* Diff vs last month */}
                      <div className="dash-cat-meta-row">
                        <span className="dash-cat-meta-diff">
                          {cat.lastMonthAmount > 0 ? (
                            <span style={{ color: isIncreased ? '#EE5D50' : '#01B574' }}>
                              {isIncreased ? '↑ +' : '↓ '}{formatINR(Math.abs(cat.diff))} vs last mo
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>New this month</span>
                          )}
                        </span>
                        <span className="dash-cat-meta-arrow">Details →</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            {topCategories.length > 0 && (
              <div className="dash-spending-footer-action">
                <button
                  type="button"
                  className="dash-link-action-btn"
                  onClick={() => onNavigateCategories?.()}
                >
                  Explore All Categories Breakdown →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: MoM SPENDING SPIKES ── */}
        {activeTab === 'spikes' && (
          <div className="dash-spikes-list">
            {spikes.length === 0 ? (
              <div className="dash-empty-state">
                No abnormal category surges detected this month. Spending is within normal limits.
              </div>
            ) : (
              spikes.map(s => {
                const emoji = getCategoryEmoji(s.category);
                return (
                  <div key={s.category} className="dash-spike-item">
                    <div className="dash-spike-left">
                      <span className="dash-spike-emoji">{emoji}</span>
                      <div>
                        <div className="dash-spike-name">{s.category}</div>
                        <div className="dash-spike-diff">
                          Surged by <strong style={{ color: '#EE5D50' }}>+{showPrivacy ? formatINR(s.diff) : '••••'}</strong> (+{s.pctChange}%)
                        </div>
                      </div>
                    </div>
                    <div className="dash-spike-right">
                      <div className="dash-spike-total">{showPrivacy ? formatINR(s.amount) : '••••'}</div>
                      <div className="dash-spike-sub">total spend</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ── TAB 3: HIGHEST INDIVIDUAL EXPENSES ── */}
        {activeTab === 'highest' && (
          <div className="dash-highest-list">
            {highestExpenses.length === 0 ? (
              <div className="dash-empty-state">No individual expenses logged this month.</div>
            ) : (
              highestExpenses.map((t, i) => (
                <div key={t.id || i} className="dash-highest-row">
                  <div className="dash-highest-rank">#{i + 1}</div>
                  <div className="dash-highest-mid">
                    <div className="dash-highest-note">{t.note}</div>
                    <div className="dash-highest-sub">
                      <span>{t.date}</span> · <span>{t.category}</span> {t.account ? `· ${t.account}` : ''}
                    </div>
                  </div>
                  <div className="dash-highest-amt expense">
                    {showPrivacy ? formatINR(t.amount) : '••••'}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── TAB 4: HISTORICAL AVERAGES & YEARLY ── */}
        {activeTab === 'history' && (
          <div className="dash-history-view">
            {/* Stat Cards Matrix */}
            <div className="dash-history-stats-grid">
              <div className="dash-history-stat-card">
                <span className="dash-h-icon">📅</span>
                <span className="dash-h-lbl">Avg Monthly Spend</span>
                <span className="dash-h-val expense">{showPrivacy ? formatINRCompact(historical.allTimeAvgMonthly) : '••••'}</span>
                <span className="dash-h-sub">across all recorded months</span>
              </div>

              <div className="dash-history-stat-card">
                <span className="dash-h-icon">📆</span>
                <span className="dash-h-lbl">Avg Yearly Spend</span>
                <span className="dash-h-val expense">{showPrivacy ? formatINRCompact(historical.allTimeAvgYearly) : '••••'}</span>
                <span className="dash-h-sub">annual historical run-rate</span>
              </div>

              <div className="dash-history-stat-card">
                <span className="dash-h-icon">🔥</span>
                <span className="dash-h-lbl">Peak Month Spend</span>
                <span className="dash-h-val" style={{ color: '#EE5D50' }}>{historical.peakMonth}</span>
                <span className="dash-h-sub">{showPrivacy ? `${formatINR(historical.peakMonthAmt)} spent` : 'Peak recorded'}</span>
              </div>

              <div className="dash-history-stat-card">
                <span className="dash-h-icon">👑</span>
                <span className="dash-h-lbl">Peak Spend Year</span>
                <span className="dash-h-val" style={{ color: '#0075FF' }}>{historical.peakYear ? `Year ${historical.peakYear}` : 'N/A'}</span>
                <span className="dash-h-sub">{showPrivacy ? `${formatINRCompact(historical.peakYearAmt)} total` : 'Annual record'}</span>
              </div>
            </div>

            {/* Yearly Table */}
            {historical.yearlyRows.length > 0 && (
              <div className="dash-yearly-table-wrap">
                <div className="dash-table-header-row">
                  <span>Year</span>
                  <span>Annual Spend</span>
                  <span>Monthly Avg</span>
                  <span>Net Savings</span>
                </div>
                {historical.yearlyRows.slice(0, 4).map(r => (
                  <div
                    key={r.year}
                    className="dash-table-data-row clickable"
                    onClick={() => onNavigateTransactions?.({ year: r.year })}
                  >
                    <span className="dash-col-year">{r.year}</span>
                    <span className="dash-col-total">{showPrivacy ? formatINRCompact(r.total) : '••••'}</span>
                    <span className="dash-col-avg">{showPrivacy ? formatINRCompact(r.monthlyAvg) : '••••'}</span>
                    <span className={`dash-col-sav ${r.savings >= 0 ? 'income' : 'expense'}`}>
                      {showPrivacy ? formatINRCompact(r.savings) : '••••'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── BUDGETS PROGRESS SECTION (IF BUDGETS CONFIGURED) ── */}
        {budgets.length > 0 && (
          <div className="dash-budgets-section">
            <div className="dash-budgets-hdr">
              <span className="dash-budgets-title">Active Budgets vs Actuals</span>
              <span className="dash-budgets-count">{budgets.length} configured</span>
            </div>
            <div className="dash-budgets-grid">
              {budgets.slice(0, 3).map(b => (
                <div key={b.category} className="dash-budget-pill-card">
                  <div className="dash-budget-top">
                    <span className="dash-b-name">{b.category}</span>
                    <span className={`dash-b-pct ${b.pct > 100 ? 'over' : b.pct > 80 ? 'warn' : 'ok'}`}>
                      {b.pct}%
                    </span>
                  </div>
                  <div className="dash-budget-track">
                    <div
                      className="dash-budget-fill"
                      style={{
                        width: `${Math.min(100, b.pct)}%`,
                        background: b.pct > 100 ? '#EE5D50' : b.pct > 80 ? '#FFAA00' : '#01B574',
                      }}
                    />
                  </div>
                  <div className="dash-budget-foot">
                    <span>{showPrivacy ? formatINR(b.spend) : '••••'}</span>
                    <span>of {showPrivacy ? formatINR(b.amount) : '••••'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

