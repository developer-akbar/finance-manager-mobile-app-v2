import React, { useState, useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';

export default function HoldingsTable({ positions = [], valuationProvider, onSelectPosition }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('cost-desc'); // 'cost-desc' | 'units-desc' | 'name-asc'

  const filteredPositions = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = positions.filter(p => p.status === 'ACTIVE');

    if (q) {
      list = list.filter(p => 
        (p.note || '').toLowerCase().includes(q) ||
        (p.security || '').toLowerCase().includes(q) ||
        (p.subAccount || '').toLowerCase().includes(q) ||
        (p.folioNumber || '').toLowerCase().includes(q) ||
        (p.isin || '').toLowerCase().includes(q)
      );
    }

    return [...list].sort((a, b) => {
      if (sortBy === 'cost-desc') return b.remainingCostBasis - a.remainingCostBasis;
      if (sortBy === 'units-desc') return b.currentUnits - a.currentUnits;
      if (sortBy === 'name-asc') return (a.note || a.security).localeCompare(b.note || b.security);
      return 0;
    });
  }, [positions, search, sortBy]);

  const getUnvaluedLabel = (pos) => {
    if (pos.investmentAccount === 'Share Market' || pos.holdingMode === 'DEMAT') {
      return 'Price unavailable';
    }
    return 'NAV unavailable';
  };

  return (
    <div className="portfolio-card holdings-card">
      <div className="portfolio-card-header flex-between">
        <div>
          <h4 className="portfolio-card-title">
            Active Positions <span className="count-badge">{filteredPositions.length}</span>
          </h4>
          <div className="portfolio-card-sub">{filteredPositions.length} active investment positions</div>
        </div>

        <div className="holdings-controls">
          <input
            type="text"
            className="holdings-search-input"
            placeholder="Search security, folio, ISIN..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select 
            className="holdings-sort-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="cost-desc">Sort: Highest Cost</option>
            <option value="units-desc">Sort: Most Units</option>
            <option value="name-asc">Sort: Security Name</option>
          </select>
        </div>
      </div>

      {filteredPositions.length === 0 ? (
        <div className="portfolio-empty-state">
          No active positions match your criteria.
        </div>
      ) : (
        <>
          {/* Desktop Table View */}
          <div className="holdings-table-container desktop-only">
            <table className="holdings-table">
              <thead>
                <tr>
                  <th>Security / Scheme</th>
                  <th>Platform</th>
                  <th>Folio / Mode</th>
                  <th style={{ textAlign: 'right' }}>Units</th>
                  <th style={{ textAlign: 'right' }}>Avg Cost</th>
                  <th style={{ textAlign: 'right' }}>Invested Cost</th>
                  <th style={{ textAlign: 'right' }}>Current NAV / Price</th>
                  <th style={{ textAlign: 'right' }}>Current Value</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredPositions.map(pos => {
                  const val = valuationProvider ? valuationProvider.getValuation(pos) : null;
                  const isValued = val && val.isValued;
                  const unvaluedLbl = getUnvaluedLabel(pos);

                  return (
                    <tr 
                      key={pos.positionKey} 
                      className="holdings-table-row clickable"
                      onClick={() => onSelectPosition(pos)}
                    >
                      <td className="fund-cell">
                        <div className="fund-primary-name">{pos.note || pos.security}</div>
                        <div className="fund-secondary-meta">
                          <span className="mono">{pos.isin}</span>
                          {pos.ownershipTag !== 'PERSONAL' && (
                            <span className={`ownership-pill ${pos.ownershipTag.toLowerCase()}`}>
                              {pos.ownershipTag}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="platform-tag">{pos.subAccount}</span>
                      </td>
                      <td>
                        <div className="folio-mode-meta">
                          <span className="folio-text mono">{pos.folioNumber}</span>
                          <span className="mode-text">{pos.holdingMode}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }} className="mono font-bold">
                        {pos.currentUnits.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                      </td>
                      <td style={{ textAlign: 'right' }} className="mono">
                        ₹{pos.averageCostPerUnit.toFixed(2)}
                      </td>
                      <td style={{ textAlign: 'right' }} className="font-bold">
                        {formatINR(pos.remainingCostBasis)}
                      </td>
                      <td style={{ textAlign: 'right' }} className="mono">
                        {isValued ? `₹${val.nav.toFixed(4)}` : <span className="val-na">{unvaluedLbl}</span>}
                      </td>
                      <td style={{ textAlign: 'right' }} className="font-bold">
                        {isValued ? (
                          <div>
                            <div>{formatINR(val.currentValue)}</div>
                            <div className={`pnl-sub ${val.unrealizedPnl >= 0 ? 'pos' : 'neg'}`}>
                              {val.unrealizedPnl >= 0 ? '+' : ''}{val.returnPercent.toFixed(1)}%
                            </div>
                          </div>
                        ) : (
                          <span className="val-na">{unvaluedLbl}</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <button 
                          className="row-view-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPosition(pos);
                          }}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card View */}
          <div className="holdings-cards-container mobile-only">
            {filteredPositions.map(pos => {
              const val = valuationProvider ? valuationProvider.getValuation(pos) : null;
              const isValued = val && val.isValued;
              const unvaluedLbl = getUnvaluedLabel(pos);

              return (
                <div 
                  key={pos.positionKey}
                  className="holding-mobile-card clickable"
                  onClick={() => onSelectPosition(pos)}
                >
                  <div className="holding-card-top">
                    <div className="holding-card-title-box">
                      <div className="holding-card-name">{pos.note || pos.security}</div>
                      <div className="holding-card-sub-meta">
                        <span className="platform-tag">{pos.subAccount}</span>
                        <span className="mode-text">{pos.holdingMode}</span>
                        {pos.ownershipTag !== 'PERSONAL' && (
                          <span className={`ownership-pill ${pos.ownershipTag.toLowerCase()}`}>
                            {pos.ownershipTag}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="holding-card-units-box">
                      <div className="holding-card-units-val">
                        {pos.currentUnits.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                      </div>
                      <div className="holding-card-units-lbl">Units</div>
                    </div>
                  </div>

                  <div className="holding-card-metrics-grid">
                    <div className="card-metric-col">
                      <span className="card-metric-lbl">Invested Cost</span>
                      <span className="card-metric-val font-bold">{formatINR(pos.remainingCostBasis)}</span>
                    </div>
                    <div className="card-metric-col">
                      <span className="card-metric-lbl">Avg Cost</span>
                      <span className="card-metric-val mono">₹{pos.averageCostPerUnit.toFixed(2)}</span>
                    </div>
                    <div className="card-metric-col">
                      <span className="card-metric-lbl">Current Value</span>
                      <span className="card-metric-val">
                        {isValued ? formatINR(val.currentValue) : <span className="val-na">{unvaluedLbl}</span>}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
