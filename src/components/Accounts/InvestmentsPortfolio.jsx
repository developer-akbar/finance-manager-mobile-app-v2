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
    tradeStats,
    isFetchingValuations,
    lastValuedAt,
    refreshValuations,
    valuationVersion
  } = usePortfolio(transactions, settings, {
    scopeFilter,
    platformFilter,
    accountFilter,
    valuationProvider: defaultValuationProvider
  });

  // Cascading Filter Handlers
  const handleScopeChange = (newScope) => {
    setScopeFilter(newScope);
    setAccountFilter('all');
    setPlatformFilter('all');
  };

  const handleAccountChange = (newAccount) => {
    setAccountFilter(newAccount);
    setPlatformFilter('all');
  };

  const isFilterActive = scopeFilter !== 'personal' || accountFilter !== 'all' || platformFilter !== 'all';

  const handleClearFilters = () => {
    setScopeFilter('personal');
    setAccountFilter('all');
    setPlatformFilter('all');
  };

  // If position detail is selected, render full-page Investment Details view
  if (selectedPosition) {
    return (
      <HoldingDetailSheet
        position={selectedPosition}
        valuationProvider={defaultValuationProvider}
        valuationVersion={valuationVersion}
        onClose={() => setSelectedPosition(null)}
      />
    );
  }

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
        <div className="portfolio-header-actions">
          <button 
            className="portfolio-refresh-btn"
            onClick={() => refreshValuations(true)}
            disabled={isFetchingValuations}
            title="Refresh live market & NAV prices"
          >
            <svg 
              className={isFetchingValuations ? 'spinning' : ''} 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2.5" 
              width="14" 
              height="14"
            >
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            <span>{isFetchingValuations ? 'Refreshing...' : 'Prices'}</span>
          </button>
          <div className="portfolio-valuation-badge" title="Valuation Abstraction Boundary">
            <span>
              {summaryMetrics.isFullyValued ? '🟢 Available' : summaryMetrics.hasPartialValuation ? '🟡 Partial' : '⚪ Cost Basis'}
            </span>
          </div>
        </div>
      </div>

      {/* Filter Bar — Cascading Order: Scope -> Account -> Platform */}
      <div className="portfolio-compact-filter-bar">
        {/* 1. Scope Filter */}
        <div className="compact-filter-item">
          <label className="compact-filter-lbl">Scope</label>
          <div className="compact-select-wrapper">
            <select 
              className="compact-filter-select"
              value={scopeFilter}
              onChange={e => handleScopeChange(e.target.value)}
            >
              <option value="personal">My Portfolio</option>
              <option value="father">Father's Holdings</option>
              <option value="all">All Holdings</option>
            </select>
            <span className="compact-select-arrow">▼</span>
          </div>
        </div>

        {/* 2. Account Filter */}
        <div className="compact-filter-item account-item">
          <label className="compact-filter-lbl">Account</label>
          <div className="compact-select-wrapper">
            <select 
              className="compact-filter-select"
              value={accountFilter}
              onChange={e => handleAccountChange(e.target.value)}
            >
              <option value="all">All Accounts</option>
              {availableAccounts.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <span className="compact-select-arrow">▼</span>
          </div>
        </div>

        {/* 3. Platform Filter */}
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

        {/* Clear Filters Action */}
        {isFilterActive && (
          <button 
            className="compact-clear-filters-btn"
            onClick={handleClearFilters}
            title="Reset filters to default"
          >
            Clear filters
          </button>
        )}
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
          isFetchingValuations={isFetchingValuations}
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
              valuationVersion={valuationVersion}
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
            scopeFilter={scopeFilter}
            accountFilter={accountFilter}
            platformFilter={platformFilter}
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
    </div>
  );
}

