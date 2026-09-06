import React, { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { usePortfolio } from '../../hooks/usePortfolio.js';
import { defaultValuationProvider } from '../../utils/valuationProvider.js';

import PortfolioSummary from './Portfolio/PortfolioSummary.jsx';
import PortfolioAllocation from './Portfolio/PortfolioAllocation.jsx';
import PortfolioPerformance from './Portfolio/PortfolioPerformance.jsx';
import HoldingsTable from './Portfolio/HoldingsTable.jsx';
import HoldingDetailSheet from './Portfolio/HoldingDetailSheet.jsx';
import RedeemedInvestments from './Portfolio/RedeemedInvestments.jsx';
import PortfolioDataIssues from './Portfolio/PortfolioDataIssues.jsx';
import InvestmentActivity from './Portfolio/InvestmentActivity.jsx';

import './InvestmentsPortfolio.css';

export default function InvestmentsPortfolio({ onBack, backInterceptRef }) {
  const { state } = useApp();
  const { transactions = [], settings = {} } = state;

  // View & Filter state
  const [activeTab, setActiveTab] = useState('holdings'); // 'holdings' | 'allocation' | 'redeemed' | 'activity' | 'issues'
  const [scopeFilter, setScopeFilter] = useState('personal'); // 'personal' | 'all' | 'father'
  const [platformFilter, setPlatformFilter] = useState('all'); // 'all' | subaccount name
  const [accountFilter, setAccountFilter] = useState('all'); // 'all' | account name
  const [selectedPosition, setSelectedPosition] = useState(null);

  // Intercept back button: close position detail if open, else trigger onBack
  useEffect(() => {
    if (!backInterceptRef) return;
    if (selectedPosition) {
      backInterceptRef.current = () => {
        setSelectedPosition(null);
      };
    } else {
      backInterceptRef.current = onBack;
    }
    return () => {
      if (backInterceptRef) backInterceptRef.current = null;
    };
  }, [selectedPosition, onBack, backInterceptRef]);

  // Derived Portfolio Data via Custom Hook
  const {
    displayedPositions,
    activeHoldings,
    redeemedHoldings,
    dataIssues,
    availablePlatforms,
    availableAccounts,
    summaryMetrics,
    tradeStats
  } = usePortfolio(transactions, settings, {
    scopeFilter,
    platformFilter,
    accountFilter,
    valuationProvider: defaultValuationProvider
  });

  return (
    <div className="investments-portfolio-screen">
      {/* Portfolio Top Bar */}
      <div className="portfolio-top-bar">
        <button className="portfolio-back-btn" onClick={onBack} title="Back to Accounts">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="20" height="20">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="portfolio-top-titles">
          <h2 className="portfolio-main-title">Investment Portfolio</h2>
          <div className="portfolio-main-subtitle">Mutual Funds, Share Market & ETFs</div>
        </div>
        <div className="portfolio-valuation-badge" title="Valuation Abstraction Boundary">
          <span>{summaryMetrics.isFullyValued ? '🟢 Live Valuation' : summaryMetrics.hasPartialValuation ? '🟡 Partial Valuation' : '⚪ Cost Basis View'}</span>
        </div>
      </div>

      {/* Sleek Compact Inline Filter Bar (Direct Dropdowns In-Place) */}
      <div className="portfolio-compact-filter-bar">
        <div className="compact-filter-item">
          <label className="compact-filter-lbl">Scope</label>
          <div className="compact-select-wrapper">
            <select 
              className="compact-filter-select"
              value={scopeFilter}
              onChange={e => setScopeFilter(e.target.value)}
            >
              <option value="personal">My Portfolio</option>
              <option value="father">Father's Holdings</option>
              <option value="all">All Holdings</option>
            </select>
            <span className="compact-select-arrow">▼</span>
          </div>
        </div>

        <div className="compact-filter-item">
          <label className="compact-filter-lbl">Platform</label>
          <div className="compact-select-wrapper">
            <select 
              className="compact-filter-select"
              value={platformFilter}
              onChange={e => setPlatformFilter(e.target.value)}
            >
              <option value="all">All Platforms</option>
              {availablePlatforms.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <span className="compact-select-arrow">▼</span>
          </div>
        </div>

        <div className="compact-filter-item account-item">
          <label className="compact-filter-lbl">Account</label>
          <div className="compact-select-wrapper">
            <select 
              className="compact-filter-select"
              value={accountFilter}
              onChange={e => setAccountFilter(e.target.value)}
            >
              <option value="all">All Accounts</option>
              {availableAccounts.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <span className="compact-select-arrow">▼</span>
          </div>
        </div>
      </div>

      {/* Scrollable Dashboard Body */}
      <div className="portfolio-scrollable-content">
        {/* KPI Hero Summary Cards */}
        <PortfolioSummary
          activeCostBasis={summaryMetrics.activeCostBasis}
          activeUnits={summaryMetrics.activeUnits}
          totalRealizedPnl={summaryMetrics.totalRealizedPnl}
          totalValuedAmount={summaryMetrics.totalValuedAmount}
          valuedCostBasis={summaryMetrics.valuedCostBasis}
          valuedUnrealizedPnl={summaryMetrics.valuedUnrealizedPnl}
          valuedReturnPercent={summaryMetrics.valuedReturnPercent}
          totalUnrealizedPnl={summaryMetrics.totalUnrealizedPnl}
          unrealizedReturnPercent={summaryMetrics.unrealizedReturnPercent}
          isFullyValued={summaryMetrics.isFullyValued}
          hasPartialValuation={summaryMetrics.hasPartialValuation}
          valuedCount={summaryMetrics.valuedCount}
          totalActiveCount={summaryMetrics.totalActiveCount}
          brokerageCash={summaryMetrics.brokerageCash}
          totalFinancialAssets={summaryMetrics.totalFinancialAssets}
          activeHoldingsCount={summaryMetrics.activeHoldingsCount}
          redeemedCount={summaryMetrics.redeemedCount}
          dataIssuesCount={summaryMetrics.dataIssuesCount}
          platformCount={summaryMetrics.platformCount}
          onOpenDataIssues={() => setActiveTab('issues')}
        />

        {/* View Navigation Tabs */}
        <div className="portfolio-nav-tabs">
          <button 
            className={`portfolio-nav-tab ${activeTab === 'holdings' ? 'active' : ''}`}
            onClick={() => setActiveTab('holdings')}
          >
            Active Positions ({activeHoldings.length})
          </button>
          <button 
            className={`portfolio-nav-tab ${activeTab === 'allocation' ? 'active' : ''}`}
            onClick={() => setActiveTab('allocation')}
          >
            Allocation
          </button>
          <button 
            className={`portfolio-nav-tab ${activeTab === 'redeemed' ? 'active' : ''}`}
            onClick={() => setActiveTab('redeemed')}
          >
            Redeemed ({redeemedHoldings.length})
          </button>
          <button 
            className={`portfolio-nav-tab ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
          >
            Activity
          </button>
          {dataIssues.length > 0 && (
            <button 
              className={`portfolio-nav-tab warning ${activeTab === 'issues' ? 'active' : ''}`}
              onClick={() => setActiveTab('issues')}
            >
              Data Issues ({dataIssues.length})
            </button>
          )}
        </div>

        {/* Tab Content Display */}
        {activeTab === 'holdings' && (
          <>
            <HoldingsTable 
              positions={displayedPositions}
              valuationProvider={defaultValuationProvider}
              onSelectPosition={pos => setSelectedPosition(pos)}
            />
            <div style={{ height: 16 }} />
            <PortfolioAllocation positions={displayedPositions} />
            <div style={{ height: 16 }} />
            <PortfolioPerformance 
              positions={displayedPositions}
              transactions={transactions}
              isValued={summaryMetrics.isValued} 
            />
          </>
        )}

        {activeTab === 'allocation' && (
          <PortfolioAllocation positions={displayedPositions} />
        )}

        {activeTab === 'redeemed' && (
          <RedeemedInvestments 
            positions={displayedPositions}
            onSelectPosition={pos => setSelectedPosition(pos)}
          />
        )}

        {activeTab === 'activity' && (
          <InvestmentActivity 
            transactions={transactions}
            onSelectTxn={txn => {}}
          />
        )}

        {activeTab === 'issues' && (
          <PortfolioDataIssues 
            positions={displayedPositions}
            onSelectPosition={pos => setSelectedPosition(pos)}
          />
        )}

        <div style={{ height: 40 }} />
      </div>

      {/* Position Detail Sheet */}
      {selectedPosition && (
        <HoldingDetailSheet
          position={selectedPosition}
          valuation={defaultValuationProvider.getValuation(selectedPosition)}
          onClose={() => setSelectedPosition(null)}
        />
      )}
    </div>
  );
}
