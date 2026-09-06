import React from 'react';
import { formatINR } from '../../../utils/format.js';

export default function PortfolioDataIssues({ positions = [], onSelectPosition }) {
  const issues = positions.filter(p => p.status === 'LEGACY_DATA_ISSUE');

  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="portfolio-card data-issue-card">
      <div className="portfolio-card-header">
        <div className="data-issue-badge">⚠️ 1 Historical Issue</div>
        <h4 className="portfolio-card-title">
          Portfolio Health ({issues.length} Issue)
        </h4>
        <div className="portfolio-card-sub">
          Historical data inconsistency — This legacy position is excluded from active portfolio calculations.
        </div>
      </div>

      <div className="data-issue-list">
        {issues.map(pos => (
          <div 
            key={pos.positionKey} 
            className="data-issue-item clickable"
            onClick={() => onSelectPosition(pos)}
          >
            <div className="data-issue-left">
              <div className="data-issue-name">{pos.note || pos.security}</div>
              <div className="data-issue-meta">
                <span>Platform: {pos.subAccount}</span> · 
                <span className="mono"> ISIN: {pos.isin}</span> · 
                <span> Account: {pos.investmentAccount}</span>
              </div>
              <div className="data-issue-desc">
                Historical data inconsistency: Franklin India Ultra Short Bond ({pos.isin}). 
                Preserved as immutable historical record; excluded from active portfolio calculations.
              </div>
            </div>
            <div className="data-issue-right">
              <div className="data-issue-units neg">
                {pos.currentUnits.toFixed(3)} Units
              </div>
              <button 
                className="row-view-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPosition(pos);
                }}
              >
                Inspect Lots
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
