import React, { useState, useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';
import { 
  aggregatePositionsForDisplay, 
  getInvestmentDisplayMetrics, 
  formatAsOfDate, 
  formatSignedCurrency, 
  formatSignedPercent 
} from '../../../utils/portfolioAggregation.js';

export default function HoldingsTable({ positions = [], valuationProvider, valuationVersion, onSelectPosition }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('cost-desc'); // 'cost-desc' | 'units-desc' | 'name-asc' | 'value-desc'
  const [expandedGroups, setExpandedGroups] = useState({});

  // 1. Group active positions by scheme identity
  const aggregatedGroups = useMemo(() => {
    return aggregatePositionsForDisplay(positions, valuationProvider);
  }, [positions, valuationProvider, valuationVersion]);

  // 2. Filter & Sort aggregated groups
  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = aggregatedGroups;

    if (q) {
      list = list.filter(g => 
        (g.note || '').toLowerCase().includes(q) ||
        (g.security || '').toLowerCase().includes(q) ||
        (g.subAccount || '').toLowerCase().includes(q) ||
        (g.isin || '').toLowerCase().includes(q) ||
        g.underlyingPositions.some(p => (p.folioNumber || '').toLowerCase().includes(q))
      );
    }

    return [...list].sort((a, b) => {
      if (sortBy === 'cost-desc') return b.remainingCostBasis - a.remainingCostBasis;
      if (sortBy === 'value-desc') {
        const valA = a.valuation?.currentValue || a.remainingCostBasis;
        const valB = b.valuation?.currentValue || b.remainingCostBasis;
        return valB - valA;
      }
      if (sortBy === 'units-desc') return b.currentUnits - a.currentUnits;
      if (sortBy === 'name-asc') return (a.note || a.security).localeCompare(b.note || b.security);
      return 0;
    });
  }, [aggregatedGroups, search, sortBy]);

  const toggleExpand = (groupKey, e) => {
    if (e) e.stopPropagation();
    setExpandedGroups(prev => ({
      ...prev,
      [groupKey]: !prev[groupKey]
    }));
  };

  const getPnlClass = (val) => {
    if (val > 0) return 'pos';
    if (val < 0) return 'neg';
    return '';
  };

  const totalRawPositionsCount = positions.filter(p => p.status === 'ACTIVE').length;

  return (
    <div className="portfolio-card holdings-card">
      <div className="portfolio-card-header flex-between">
        <div>
          <h4 className="portfolio-card-title">
            Active Holdings <span className="count-badge">{filteredGroups.length}</span>
          </h4>
          <div className="portfolio-card-sub">
            {filteredGroups.length} active scheme{filteredGroups.length !== 1 ? 's' : ''} ({totalRawPositionsCount} folios)
          </div>
        </div>

        <div className="holdings-controls">
          <input
            type="text"
            className="holdings-search-input"
            placeholder="Search scheme, ISIN, folio..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select 
            className="holdings-sort-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="cost-desc">Sort: Highest Cost</option>
            <option value="value-desc">Sort: Highest Current Value</option>
            <option value="units-desc">Sort: Most Units</option>
            <option value="name-asc">Sort: Security Name</option>
          </select>
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="portfolio-empty-state">
          No active holdings match your criteria.
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
                  <th>Folios / Mode</th>
                  <th style={{ textAlign: 'right' }}>Current Value</th>
                  <th style={{ textAlign: 'right' }}>Invested</th>
                  <th style={{ textAlign: 'right' }}>Total Returns / P&L</th>
                  <th style={{ textAlign: 'right' }}>NAV / LTP</th>
                  <th style={{ textAlign: 'right' }}>Units / Qty & Avg</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredGroups.map(group => {
                  const val = group.valuation;
                  const isValued = val && val.isValued;
                  const metrics = getInvestmentDisplayMetrics(group);
                  const isExpanded = !!expandedGroups[group.positionKey];

                  return (
                    <React.Fragment key={group.positionKey}>
                      <tr 
                        className={`holdings-table-row clickable ${group.isAggregateGroup ? 'aggregated-row' : ''}`}
                        onClick={() => onSelectPosition(group)}
                      >
                        <td className="fund-cell">
                          <div className="fund-primary-name">{group.note || group.security}</div>
                          <div className="fund-secondary-meta">
                            <span className="mono font-xs text-muted">{group.isin}</span>
                            {group.ownershipTag !== 'PERSONAL' && (
                              <span className={`ownership-pill ${group.ownershipTag.toLowerCase()}`}>
                                {group.ownershipTag}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="platform-tag">{group.subAccount}</span>
                        </td>
                        <td>
                          <div className="folio-mode-meta">
                            {group.isAggregateGroup ? (
                              <button 
                                className="folio-expand-badge-btn"
                                onClick={(e) => toggleExpand(group.positionKey, e)}
                                title="Click to expand folios"
                              >
                                {group.folioCount} folios {isExpanded ? '▲' : '▼'}
                              </button>
                            ) : (
                              <>
                                <span className="folio-text mono text-muted">Folio {group.folioNumber}</span>
                                <span className="mode-text text-muted">{group.holdingMode}</span>
                              </>
                            )}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }} className="font-bold current-val-cell num-tabular">
                          {isValued ? formatINR(val.currentValue) : <span className="val-na text-muted">{metrics.unvaluedLabel}</span>}
                        </td>
                        <td style={{ textAlign: 'right' }} className="mono text-muted num-tabular">
                          {formatINR(group.remainingCostBasis)}
                        </td>
                        <td style={{ textAlign: 'right' }} className="num-tabular">
                          {isValued ? (
                            <div className={`pnl-sub ${getPnlClass(val.unrealizedPnl)}`}>
                              <div className="font-bold">{formatSignedCurrency(val.unrealizedPnl)}</div>
                              <div className="pnl-pct-small font-semibold">
                                ({formatSignedPercent(val.returnPercent)})
                              </div>
                            </div>
                          ) : (
                            <span className="val-na text-muted">{metrics.unvaluedLabel}</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }} className="mono num-tabular">
                          {isValued && typeof val.nav === 'number' ? (
                            <div>
                              <div className="font-semibold">{metrics.priceLabel} ₹{val.nav.toFixed(4)}</div>
                              {val.asOf && <div className="text-muted font-xs">As of {formatAsOfDate(val.asOf)}</div>}
                            </div>
                          ) : (
                            <span className="val-na text-muted">{metrics.unvaluedLabel}</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }} className="mono font-xs text-muted num-tabular">
                          <div>{metrics.formattedQty}</div>
                          <div>{metrics.formattedAvgPrice}</div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <button 
                            className="row-view-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectPosition(group);
                            }}
                          >
                            Details
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Sub-Rows for Aggregated Folios */}
                      {group.isAggregateGroup && isExpanded && (
                        group.underlyingPositions.map((subPos, idx) => {
                          const subVal = valuationProvider ? valuationProvider.getValuation(subPos) : null;
                          const subIsValued = subVal && subVal.isValued;
                          const subMetrics = getInvestmentDisplayMetrics(subPos);
                          return (
                            <tr 
                              key={subPos.positionKey || idx}
                              className="folio-sub-row clickable"
                              onClick={() => onSelectPosition(subPos)}
                            >
                              <td className="fund-cell sub-row-cell" colSpan={2}>
                                <div className="sub-row-indent">
                                  ↳ <span className="sub-row-platform">{subPos.subAccount}</span>
                                </div>
                              </td>
                              <td>
                                <div className="folio-mode-meta">
                                  <span className="folio-text mono text-muted">Folio {subPos.folioNumber}</span>
                                  <span className="mode-text text-muted">{subPos.holdingMode}</span>
                                </div>
                              </td>
                              <td style={{ textAlign: 'right' }} className="font-semibold num-tabular">
                                {subIsValued ? formatINR(subVal.currentValue) : '—'}
                              </td>
                              <td style={{ textAlign: 'right' }} className="mono text-muted num-tabular">
                                {formatINR(subPos.remainingCostBasis)}
                              </td>
                              <td style={{ textAlign: 'right' }} className="num-tabular">
                                {subIsValued ? (
                                  <span className={getPnlClass(subVal.unrealizedPnl)}>
                                    {formatSignedCurrency(subVal.unrealizedPnl)}
                                  </span>
                                ) : '—'}
                              </td>
                              <td style={{ textAlign: 'right' }} className="mono text-muted num-tabular">
                                {subIsValued ? `${subMetrics.priceLabel} ₹${subVal.nav.toFixed(2)}` : '—'}
                              </td>
                              <td style={{ textAlign: 'right' }} className="mono font-xs text-muted num-tabular">
                                {subMetrics.formattedQty}
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <button 
                                  className="row-view-btn sub-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSelectPosition(subPos);
                                  }}
                                >
                                  Folio Details
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

                  {/* Mobile Card View — Clean Groww-Inspired Information Hierarchy */}
          <div className="holdings-cards-container mobile-only">
            {filteredGroups.map(group => {
              const val = group.valuation;
              const isValued = val && val.isValued;
              const metrics = getInvestmentDisplayMetrics(group);
              const isExpanded = !!expandedGroups[group.positionKey];

              return (
                <div key={group.positionKey} className="holding-mobile-card-group">
                  <div 
                    className={`holding-mobile-card clickable ${group.isAggregateGroup ? 'aggregated-card' : ''}`}
                    onClick={() => onSelectPosition(group)}
                  >
                    {/* 1. Header: Top-Left Security Name + Top-Right CURRENT VALUE */}
                    <div className="holding-card-header flex-between align-start">
                      <div className="holding-card-title-box">
                        <div className="holding-card-name line-clamp-2">{group.note || group.security}</div>
                        <div className="holding-card-sub-meta text-muted flex-gap-xs align-center mt-1">
                          <span className="platform-tag">{group.subAccount}</span>
                          {group.ownershipTag === 'MIXED_HOLDING' && (
                            <span className="platform-tag mixed-tag">MIXED HOLDING</span>
                          )}
                          {group.isAggregateGroup && (
                            <button 
                              className="folio-expand-badge-btn"
                              onClick={(e) => toggleExpand(group.positionKey, e)}
                            >
                              {group.folioCount} folios {isExpanded ? '▲' : '▼'}
                            </button>
                          )}
                          {group.ownershipTag !== 'PERSONAL' && group.ownershipTag !== 'MIXED_HOLDING' && (
                            <span className={`ownership-pill ${group.ownershipTag.toLowerCase()}`}>
                              {group.ownershipTag}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Top-Right Hero Current Value (Label ABOVE Amount) */}
                      <div className="card-primary-hero text-right">
                        <span className="hero-lbl text-muted uppercase block">{metrics.valueLabel}</span>
                        <div className={`hero-val font-extrabold num-tabular ${isValued ? getPnlClass(val.currentValue - group.remainingCostBasis) : ''}`}>
                          {isValued ? formatINR(val.currentValue) : <span className="val-na text-muted">{metrics.unvaluedLabel}</span>}
                        </div>
                      </div>
                    </div>

                    {/* 2. Secondary Financial Metrics: Invested vs Total returns / P&L vs XIRR */}
                    <div className="card-secondary-grid grid-3 mt-2">
                      <div className="sec-col">
                        <span className="sec-lbl text-muted uppercase">{metrics.costLabel}</span>
                        <span className="sec-val font-semibold num-tabular">{formatINR(group.remainingCostBasis)}</span>
                      </div>
                      <div className="sec-col text-center">
                        <span className="sec-lbl text-muted uppercase">{metrics.returnLabel}</span>
                        {isValued ? (
                          <span className={`sec-val font-semibold num-tabular ${getPnlClass(val.unrealizedPnl)}`}>
                            {formatSignedCurrency(val.unrealizedPnl)} ({formatSignedPercent(val.returnPercent)})
                          </span>
                        ) : (
                          <span className="sec-val text-muted">—</span>
                        )}
                      </div>
                      <div className="sec-col text-right">
                        <span className="sec-lbl text-muted uppercase">XIRR</span>
                        {isValued && metrics.isMf && typeof val.returnPercent === 'number' ? (
                          <span className={`sec-val font-semibold num-tabular ${getPnlClass(val.returnPercent)}`}>
                            {formatSignedPercent(val.returnPercent)}
                          </span>
                        ) : (
                          <span className="sec-val text-muted">—</span>
                        )}
                      </div>
                    </div>

                    {/* 3. Three-Column Primary Metadata Grid */}
                    <div className="card-metadata-grid grid-3 mt-2 font-xs text-muted">
                      <div className="meta-col">
                        <span className="meta-lbl block">{metrics.priceLabel}</span>
                        <span className="meta-val font-bold text-primary block num-tabular">
                          {isValued && typeof val.nav === 'number' ? `₹${val.nav.toFixed(2)}` : '—'}
                        </span>
                        {isValued && val.asOf && (
                          <span className="meta-sub-date block text-muted">
                            As of {formatAsOfDate(val.asOf)}{val.asOfTime ? `, ${val.asOfTime}` : ''}
                          </span>
                        )}
                      </div>

                      <div className="meta-col">
                        <span className="meta-lbl block">{metrics.avgPriceLabel}</span>
                        <span className="meta-val font-semibold block num-tabular">
                          {metrics.formattedAvgPrice.replace(/^(Avg NAV|Avg Price)\s*/, '')}
                        </span>
                      </div>

                      <div className="meta-col text-right">
                        <span className="meta-lbl block">{metrics.qtyLabel}</span>
                        <span className="meta-val font-semibold block num-tabular">
                          {metrics.rawQty || metrics.formattedQty}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Expanded Sub-Cards for Aggregated Folios — Clean 3-Column Grid */}
                  {group.isAggregateGroup && isExpanded && (
                    <div className="mobile-sub-cards-drawer">
                      {group.underlyingPositions.map((subPos, idx) => {
                        const subVal = valuationProvider ? valuationProvider.getValuation(subPos) : null;
                        const subIsValued = subVal && subVal.isValued;
                        const subMetrics = getInvestmentDisplayMetrics(subPos);

                        return (
                          <div 
                            key={subPos.positionKey || idx}
                            className="mobile-sub-card clickable"
                            onClick={() => onSelectPosition(subPos)}
                          >
                            <div className="sub-card-top flex-between mb-2">
                              <div>
                                <div className="font-bold text-sm text-primary">Folio {subPos.folioNumber}</div>
                                <div className="text-muted font-xs mt-0.5">{subPos.subAccount}</div>
                              </div>
                            </div>
                            
                            <div className="sub-card-grid grid-3 font-xs num-tabular pt-2 border-top">
                              <div>
                                <span className="text-muted block uppercase">Units</span>
                                <span className="font-semibold block mt-0.5">{subMetrics.rawQty || subMetrics.formattedQty}</span>
                              </div>
                              <div>
                                <span className="text-muted block uppercase">Invested</span>
                                <span className="font-semibold block mt-0.5">{formatINR(subPos.remainingCostBasis)}</span>
                              </div>
                              <div className="text-right">
                                <span className="text-muted block uppercase">Current Value</span>
                                <span className="font-bold block mt-0.5 text-primary">
                                  {subIsValued ? formatINR(subVal.currentValue) : '—'}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}


