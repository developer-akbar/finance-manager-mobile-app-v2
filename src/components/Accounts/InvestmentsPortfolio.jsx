import React, { useState, useMemo, useEffect } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatINRCompact, parseDate, calculateAge, txnAmount } from '../../utils/format.js';
import TransactionItem from '../Transactions/TransactionItem.jsx';
import './InvestmentsPortfolio.css';

const RADIAN = Math.PI / 180;
const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, index }) => {
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" style={{ fontSize: '0.68rem', fontWeight: 'bold' }}>
      {percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ''}
    </text>
  );
};

export default function InvestmentsPortfolio({ onBack, backInterceptRef }) {
  const { state } = useApp();
  const { transactions, accounts } = state;

  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('active'); // 'active' | 'redeemed'
  const [sortBy, setSortBy] = useState('date-desc'); // 'date-desc' | 'date-asc' | 'amount-desc' | 'age-desc'

  // Back button interception
  useEffect(() => {
    if (!backInterceptRef) return;
    backInterceptRef.current = onBack;
    return () => {
      if (backInterceptRef) backInterceptRef.current = null;
    };
  }, [onBack, backInterceptRef]);

  // 1. Identify Investment Accounts
  const investmentAccounts = useMemo(() => {
    return (accounts || []).filter(a => a.group?.toLowerCase() === 'investments');
  }, [accounts]);

  const isInvestmentAccount = useMemo(() => {
    const names = new Set(investmentAccounts.map(a => a.name.toLowerCase()));
    return (name) => name ? names.has(name.toLowerCase()) : false;
  }, [investmentAccounts]);

  // Helper to determine if a transaction belongs to investments
  const isInvestmentTxn = useMemo(() => {
    return (t) => {
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      return isInvestmentAccount(acct) || isInvestmentAccount(dest);
    };
  }, [isInvestmentAccount]);

  // 2. Fetch and calculate Portfolio Balance Map & Invested Capital
  const {
    accountBalances,
    totalPortfolioValue,
    netInvestedByAccount,
    totalInvestedCapital,
    portfolioGainLoss,
    gainLossPercent,
    allInvestmentTxns
  } = useMemo(() => {
    // Current Balances
    const balances = {};
    investmentAccounts.forEach(a => {
      balances[a.name] = 0;
    });

    // Net Invested Capital
    const invested = {};
    investmentAccounts.forEach(a => {
      invested[a.name] = 0;
    });

    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
    const addToBal = (n, v) => {
      if (n && !looksNumeric(n) && balances[n] !== undefined) {
        balances[n] = (balances[n] || 0) + v;
      }
    };

    const txns = [];

    for (const t of transactions) {
      const amt = parseFloat(t.INR || t.Amount || 0);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = String(t.Account || t.FromAccount || '').trim();
      const dest = String(t.ToAccount || '').trim();

      const isAcctInv = isInvestmentAccount(acct);
      const isDestInv = isInvestmentAccount(dest);

      if (isAcctInv || isDestInv) {
        txns.push(t);
      }

      // Balance Map computation
      if (type === 'Income') {
        addToBal(acct, +amt);
      } else if (type === 'Expense') {
        addToBal(acct, -amt);
      } else if (type === 'Transfer-Out') {
        addToBal(acct, -amt);
        addToBal(dest, +amt);
      }

      // Invested Capital computation
      if (type === 'Transfer-Out' && isAcctInv && isDestInv) {
        continue; // internal transfer: net is 0
      }

      if (type === 'Income' && isAcctInv) {
        invested[acct] = (invested[acct] || 0) - amt;
      } else if (type === 'Expense' && isAcctInv) {
        invested[acct] = (invested[acct] || 0) + amt;
      } else if (type === 'Transfer-Out') {
        if (isAcctInv && !isDestInv) {
          // Cash out / Redemption
          invested[acct] = (invested[acct] || 0) - amt;
        } else if (!isAcctInv && isDestInv) {
          // Capital in
          invested[dest] = (invested[dest] || 0) + amt;
        }
      }
    }

    const totalVal = Object.values(balances).reduce((sum, v) => sum + v, 0);
    const totalInv = Object.values(invested).reduce((sum, v) => sum + v, 0);
    const gainLoss = totalVal - totalInv;
    const gainLossPct = totalInv > 0 ? (gainLoss / totalInv) * 100 : 0;

    return {
      accountBalances: balances,
      totalPortfolioValue: totalVal,
      netInvestedByAccount: invested,
      totalInvestedCapital: totalInv,
      portfolioGainLoss: gainLoss,
      gainLossPercent: gainLossPct,
      allInvestmentTxns: txns
    };
  }, [transactions, investmentAccounts, isInvestmentAccount]);

  // 3. Filter transactions into Active vs. Redeemed
  const { activeTxns, redeemedTxns, longTermCount, longTermValue } = useMemo(() => {
    const active = [];
    const redeemed = [];
    let ltCount = 0;
    let ltValue = 0;

    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

    for (const t of allInvestmentTxns) {
      const isRed = (t.Tags || t.tags || t.Note || t.Description || '').toLowerCase().includes('redeemed');
      if (isRed) {
        redeemed.push(t);
      } else {
        active.push(t);
        const d = parseDate(t.Date);
        if (d.getTime() > 0 && d < threeYearsAgo) {
          ltCount++;
          ltValue += parseFloat(t.INR || t.Amount || 0);
        }
      }
    }

    return {
      activeTxns: active,
      redeemedTxns: redeemed,
      longTermCount: ltCount,
      longTermValue: ltValue
    };
  }, [allInvestmentTxns]);

  // 4. Filter, Search, and Sort display list
  const filteredList = useMemo(() => {
    const list = activeTab === 'active' ? activeTxns : redeemedTxns;

    // Apply Search
    const q = search.toLowerCase().trim();
    const searched = q
      ? list.filter(t =>
          (t.Note || '').toLowerCase().includes(q) ||
          (t.Category || '').toLowerCase().includes(q) ||
          (t.Description || '').toLowerCase().includes(q) ||
          (t.Account || t.FromAccount || '').toLowerCase().includes(q) ||
          (t.ToAccount || '').toLowerCase().includes(q) ||
          (t.Tags || '').toLowerCase().includes(q)
        )
      : list;

    // Apply Sort
    const sorted = [...searched];
    sorted.sort((a, b) => {
      const da = parseDate(a.Date).getTime();
      const db = parseDate(b.Date).getTime();
      const amta = parseFloat(a.INR || a.Amount || 0);
      const amtb = parseFloat(b.INR || b.Amount || 0);

      if (sortBy === 'date-desc')   return db - da;
      if (sortBy === 'date-asc')    return da - db;
      if (sortBy === 'amount-desc') return amtb - amta;
      if (sortBy === 'age-desc')    return da - db; // oldest date first = largest age
      return 0;
    });

    return sorted;
  }, [activeTab, activeTxns, redeemedTxns, search, sortBy]);

  // 5. Chart Allocation Data
  const chartData = useMemo(() => {
    const colors = ['#00e5a0', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'];
    return Object.entries(accountBalances)
      .map(([name, val], i) => ({
        name,
        value: val > 0 ? val : 0,
        color: colors[i % colors.length]
      }))
      .filter(d => d.value > 0);
  }, [accountBalances]);

  return (
    <div className="investments-portfolio-screen">
      {/* Header */}
      <div className="page-hdr" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button 
            onClick={onBack} 
            style={{ 
              background: 'none', 
              border: 'none', 
              color: 'var(--text-muted)', 
              display: 'flex', 
              alignItems: 'center', 
              cursor: 'pointer', 
              padding: 0 
            }} 
            title="Go back"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="20" height="20" style={{ stroke: 'var(--text-muted)' }}>
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          <div className="page-hdr-title">Investment Portfolio</div>
        </div>
      </div>

      <div className="portfolio-scrollable-content">
        {/* Core Metadata Summary Stats Card */}
        <div className="portfolio-hero-card">
          <div className="portfolio-hero-main">
            <div className="portfolio-hero-lbl">Current Portfolio Value</div>
            <div className="portfolio-hero-val">{formatINR(totalPortfolioValue)}</div>
            <div className={`portfolio-hero-change ${portfolioGainLoss >= 0 ? 'profit' : 'loss'}`}>
              {portfolioGainLoss >= 0 ? '▲' : '▼'} {formatINR(Math.abs(portfolioGainLoss))} ({gainLossPercent.toFixed(2)}%)
            </div>
          </div>
          <div className="portfolio-hero-details">
            <div className="portfolio-hero-det-item">
              <div className="portfolio-hero-det-lbl">Invested Capital</div>
              <div className="portfolio-hero-det-val">{formatINR(totalInvestedCapital)}</div>
            </div>
            <div className="portfolio-hero-det-divider" />
            <div className="portfolio-hero-det-item">
              <div className="portfolio-hero-det-lbl">Long Term ({'>'} 3 Yrs)</div>
              <div className="portfolio-hero-det-val">{longTermCount} txns ({formatINRCompact(longTermValue)})</div>
            </div>
          </div>
        </div>

        {/* Charts & Asset Allocation */}
        {chartData.length > 0 && (
          <div className="portfolio-section-card">
            <div className="section-title">Asset Allocation</div>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ width: '100%', height: 180, flex: 1, minWidth: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderCustomizedLabel}
                      outerRadius={75}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(v) => [formatINR(v), 'Value']} 
                      contentStyle={{ 
                        background: 'rgba(20, 25, 40, 0.98)', 
                        border: '1px solid var(--border)', 
                        borderRadius: '12px',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                        padding: '8px 12px'
                      }}
                      itemStyle={{ color: 'var(--accent)', fontSize: '0.78rem', fontWeight: 'bold' }}
                      labelStyle={{ color: '#fff', fontSize: '0.74rem', fontWeight: 'bold', marginBottom: '4px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="portfolio-legend-list">
                {chartData.map((d, index) => {
                  const pct = totalPortfolioValue > 0 ? (d.value / totalPortfolioValue) * 100 : 0;
                  return (
                    <div key={d.name} className="legend-item">
                      <div className="legend-color-dot" style={{ backgroundColor: d.color }} />
                      <div className="legend-item-info">
                        <span className="legend-item-name">{d.name}</span>
                        <span className="legend-item-val">{formatINRCompact(d.value)} ({pct.toFixed(0)}%)</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Search & Filter Toolbar */}
        <div className="portfolio-toolbar">
          <div className="portfolio-tabs">
            <button 
              className={`portfolio-tab-btn ${activeTab === 'active' ? 'active' : ''}`}
              onClick={() => setActiveTab('active')}
            >
              Active ({activeTxns.length})
            </button>
            <button 
              className={`portfolio-tab-btn ${activeTab === 'redeemed' ? 'active' : ''}`}
              onClick={() => setActiveTab('redeemed')}
            >
              Redeemed ({redeemedTxns.length})
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <div className="portfolio-search-input-wrap">
              <input 
                type="text" 
                placeholder="Search investments..." 
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="portfolio-search-input"
              />
              {search && (
                <button className="portfolio-search-clear" onClick={() => setSearch('')}>✕</button>
              )}
            </div>
            <select 
              value={sortBy} 
              onChange={(e) => setSortBy(e.target.value)} 
              className="portfolio-sort-select"
            >
              <option value="date-desc">Newest Date</option>
              <option value="date-asc">Oldest Date</option>
              <option value="amount-desc">Highest Amount</option>
              <option value="age-desc">Longest Held (Age)</option>
            </select>
          </div>
        </div>

        {/* Investments Transaction List */}
        <div className="portfolio-txns-list">
          {filteredList.map(t => (
            <div key={t.id || t._id} className="portfolio-txn-item-card">
              <TransactionItem 
                transaction={t} 
                showDate={true} 
                backInterceptRef={backInterceptRef} 
              />
            </div>
          ))}
          {filteredList.length === 0 && (
            <div className="empty-state" style={{ padding: '40px 10px' }}>
              <div className="empty-icon">📈</div>
              <div className="empty-title">No transactions found</div>
              <div className="empty-desc">
                {search ? 'Try adjusting your search criteria.' : 'Create an investment transaction to get started.'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
