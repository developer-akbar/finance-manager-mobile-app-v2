import React, { useState, useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';
import { 
  aggregatePositionsForDisplay, 
  matchesHoldingSearch,
  getInvestmentDisplayMetrics, 
  formatAsOfDate, 
  formatSignedCurrency, 
  formatSignedPercent,
  computePositionXIRR,
  getTodaysChange
} from '../../../utils/portfolioAggregation.js';
import { detectAssetType } from '../../../utils/valuationProvider.js';

export default function HoldingsTable({ 
  positions = [], 
  valuationProvider, 
  valuationVersion, 
  oneDayDisplayMode = 'unit',
  onToggleOneDayDisplayMode = null,
  onSelectPosition 
}) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('cost');
  const [sortDir, setSortDir] = useState('desc'); // 'asc' | 'desc'
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
      list = list.filter(g => matchesHoldingSearch(g, q));
    }

    return [...list].sort((a, b) => {
      const valA = a.valuation;
      const valB = b.valuation;
      let comparison = 0;

      if (sortKey === 'name') {
        const nameA = (a.note || a.security || '').toLowerCase();
        const nameB = (b.note || b.security || '').toLowerCase();
        comparison = nameA.localeCompare(nameB);
      } else if (sortKey === 'platform') {
        const pA = (a.subAccount || '').toLowerCase();
        const pB = (b.subAccount || '').toLowerCase();
        comparison = pA.localeCompare(pB);
      } else if (sortKey === 'cost') {
        comparison = (a.remainingCostBasis || 0) - (b.remainingCostBasis || 0);
      } else if (sortKey === 'value') {
        const vA = valA?.isValued ? valA.currentValue : (a.remainingCostBasis || 0);
        const vB = valB?.isValued ? valB.currentValue : (b.remainingCostBasis || 0);
        comparison = vA - vB;
      } else if (sortKey === 'returns') {
        const pnlA = valA?.isValued ? valA.unrealizedPnl : -Infinity;
        const pnlB = valB?.isValued ? valB.unrealizedPnl : -Infinity;
        comparison = pnlA - pnlB;
      } else if (sortKey === 'oneDay') {
        const dDiffA = (valA?.isValued && typeof valA.nav === 'number' && typeof valA.previousClose === 'number')
          ? (valA.nav - valA.previousClose) * (a.currentUnits || 0)
          : -Infinity;
        const dDiffB = (valB?.isValued && typeof valB.nav === 'number' && typeof valB.previousClose === 'number')
          ? (valB.nav - valB.previousClose) * (b.currentUnits || 0)
          : -Infinity;
        comparison = dDiffA - dDiffB;
      } else if (sortKey === 'nav') {
        const nA = (valA?.isValued && typeof valA.nav === 'number') ? valA.nav : -Infinity;
        const nB = (valB?.isValued && typeof valB.nav === 'number') ? valB.nav : -Infinity;
        comparison = nA - nB;
      } else if (sortKey === 'units') {
        comparison = (a.currentUnits || 0) - (b.currentUnits || 0);
      }

      return sortDir === 'asc' ? comparison : -comparison;
    });
  }, [aggregatedGroups, search, sortKey, sortDir]);

  const handleHeaderClick = (key) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'platform' ? 'asc' : 'desc');
    }
  };

  const renderSortIndicator = (key) => {
    if (sortKey !== key) return null;
    return <span className="sort-indicator">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>;
  };

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
            value={`${sortKey}-${sortDir}`}
            onChange={e => {
              const [k, d] = e.target.value.split('-');
              setSortKey(k);
              setSortDir(d);
            }}
          >
            <option value="cost-desc">Sort: Highest Cost</option>
            <option value="value-desc">Sort: Highest Current Value</option>
            <option value="returns-desc">Sort: Highest Total Return</option>
            <option value="oneDay-desc">Sort: Highest 1D Return</option>
            <option value="units-desc">Sort: Most Units</option>
            <option value="name-asc">Sort: Security Name (A-Z)</option>
            <option value="platform-asc">Sort: Platform (A-Z)</option>
          </select>
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="portfolio-empty-state">
          No active holdings match your criteria.
        </div>
      ) : (
        <>
          {/* Desktop & Tablet Table View (>=768px) */}
          <div className="holdings-table-container">
            <table className="holdings-table">
              <thead>
                <tr>
                  <th className="sortable-th col-fund" onClick={() => handleHeaderClick('name')}>
                    Security / Scheme{renderSortIndicator('name')}
                  </th>
                  <th className="col-folio">Folios / Mode</th>
                  <th className="sortable-th col-val text-right" onClick={() => handleHeaderClick('value')}>
                    Current Value{renderSortIndicator('value')}
                  </th>
                  <th className="sortable-th col-cost text-right" onClick={() => handleHeaderClick('cost')}>
                    Invested{renderSortIndicator('cost')}
                  </th>
                  <th className="sortable-th col-pnl text-right" onClick={() => handleHeaderClick('returns')}>
                    Total Returns / P&L{renderSortIndicator('returns')}
                  </th>
                  <th className="sortable-th col-1d text-right" onClick={() => handleHeaderClick('oneDay')}>
                    1D Return{renderSortIndicator('oneDay')}
                  </th>
                  <th className="sortable-th col-nav text-right" onClick={() => handleHeaderClick('nav')}>
                    NAV / LTP{renderSortIndicator('nav')}
                  </th>
                  <th className="sortable-th col-qty text-right" onClick={() => handleHeaderClick('units')}>
                    Units / Qty & Avg{renderSortIndicator('units')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredGroups.map(group => {
                  const val = group.valuation;
                  const isValued = val && val.isValued;
                  const metrics = getInvestmentDisplayMetrics(group);
                  const isExpanded = !!expandedGroups[group.positionKey];

                  // 1D Return calculation for holding
                  const hasOneDay = isValued && typeof val.nav === 'number' && typeof val.previousClose === 'number' && val.previousClose > 0;
                  const oneDayDiff = hasOneDay ? (val.nav - val.previousClose) : null;
                  const oneDayAmount = hasOneDay ? oneDayDiff * (group.currentUnits || 0) : null;
                  const oneDayPercent = hasOneDay ? (oneDayDiff / val.previousClose) * 100 : null;

                  return (
                    <React.Fragment key={group.positionKey}>
                      <tr 
                        className={`holdings-table-row clickable ${group.isAggregateGroup ? 'aggregated-row' : ''}`}
                        onClick={() => onSelectPosition(group)}
                        title="Click to view holding details"
                      >
                        <td className="fund-cell col-fund">
                          <div className="fund-primary-name">{group.note || group.security}</div>
                          <div className="fund-secondary-meta">
                            <span className="mono font-xs text-muted">{group.isin}</span>
                            {group.subAccount && (
                              <span className="platform-tag">{group.subAccount}</span>
                            )}
                            {group.ownershipTag && group.ownershipTag !== 'PERSONAL' && group.ownershipTag !== 'MIXED_HOLDING' && (
                              <span className={`ownership-pill platform-tag ${group.ownershipTag.toLowerCase()}`}>
                                {group.ownershipTag}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="col-folio">
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
                        <td className="col-val text-right font-bold current-val-cell num-tabular">
                          {isValued ? formatINR(val.currentValue) : <span className="val-na text-muted">{metrics.unvaluedLabel}</span>}
                        </td>
                        <td className="col-cost text-right mono text-muted num-tabular font-semibold">
                          {formatINR(group.remainingCostBasis)}
                        </td>
                        <td className="col-pnl text-right num-tabular">
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
                        {/* Dedicated 1D Return Column */}
                        <td className="col-1d text-right num-tabular">
                          {hasOneDay ? (
                            <div className={`pnl-sub ${getPnlClass(oneDayAmount)}`}>
                              <div className="font-bold">{formatSignedCurrency(oneDayAmount)}</div>
                              <div className="pnl-pct-small font-semibold">
                                ({formatSignedPercent(oneDayPercent)})
                              </div>
                            </div>
                          ) : (
                            <span className="val-na text-muted">—</span>
                          )}
                        </td>
                        <td className="col-nav text-right mono num-tabular">
                          {isValued && typeof val.nav === 'number' ? (
                            <div className="nav-cell-wrap">
                              <div className="nav-val-main font-semibold text-primary">
                                {metrics.priceLabel} ₹{val.nav.toFixed(2)}
                              </div>
                              {val.asOf && (
                                <div className="nav-as-of-sub text-muted font-xs">
                                  As of {formatAsOfDate(val.asOf)}{val.asOfTime ? `, ${val.asOfTime}` : ''}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="val-na text-muted">{metrics.unvaluedLabel}</span>
                          )}
                        </td>
                        <td className="col-qty text-right mono font-xs text-muted num-tabular">
                          <div className="font-semibold text-primary">{metrics.formattedQty}</div>
                          <div>{metrics.formattedAvgPrice}</div>
                        </td>
                      </tr>

                      {/* Expanded Sub-Rows for Aggregated Folios */}
                      {group.isAggregateGroup && isExpanded && (
                        group.underlyingPositions.map((subPos, idx) => {
                          const subVal = valuationProvider ? valuationProvider.getValuation(subPos) : null;
                          const subIsValued = subVal && subVal.isValued;
                          const subMetrics = getInvestmentDisplayMetrics(subPos);
                          const subHasOneDay = subIsValued && typeof subVal.nav === 'number' && typeof subVal.previousClose === 'number' && subVal.previousClose > 0;
                          const subOneDayDiff = subHasOneDay ? (subVal.nav - subVal.previousClose) : null;
                          const subOneDayAmount = subHasOneDay ? subOneDayDiff * (subPos.currentUnits || 0) : null;
                          const subOneDayPercent = subHasOneDay ? (subOneDayDiff / subVal.previousClose) * 100 : null;

                          return (
                            <tr 
                              key={subPos.positionKey || idx}
                              className="folio-sub-row clickable"
                              onClick={() => onSelectPosition(subPos)}
                              title="Click to view folio details"
                            >
                              <td className="fund-cell sub-row-cell col-fund">
                                <div className="sub-row-indent">
                                  ↳ <span className="platform-tag">{subPos.subAccount}</span>
                                </div>
                              </td>
                              <td className="col-folio">
                                <div className="folio-mode-meta">
                                  <span className="folio-text mono text-muted">Folio {subPos.folioNumber}</span>
                                  <span className="mode-text text-muted">{subPos.holdingMode}</span>
                                </div>
                              </td>
                              <td className="col-val text-right font-semibold num-tabular">
                                {subIsValued ? formatINR(subVal.currentValue) : '—'}
                              </td>
                              <td className="col-cost text-right mono text-muted num-tabular">
                                {formatINR(subPos.remainingCostBasis)}
                              </td>
                              <td className="col-pnl text-right num-tabular">
                                {subIsValued ? (
                                  <span className={getPnlClass(subVal.unrealizedPnl)}>
                                    {formatSignedCurrency(subVal.unrealizedPnl)}
                                  </span>
                                ) : '—'}
                              </td>
                              <td className="col-1d text-right num-tabular">
                                {subHasOneDay ? (
                                  <span className={getPnlClass(subOneDayAmount)}>
                                    {formatSignedCurrency(subOneDayAmount)}
                                  </span>
                                ) : '—'}
                              </td>
                              <td className="col-nav text-right mono text-muted num-tabular">
                                {subIsValued ? `${subMetrics.priceLabel} ₹${subVal.nav.toFixed(2)}` : '—'}
                              </td>
                              <td className="col-qty text-right mono font-xs text-muted num-tabular">
                                {subMetrics.formattedQty}
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

          {/* Mobile Card View (<768px) — Clean Groww-Inspired Information Hierarchy */}
          <div className="holdings-cards-container">
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
                          {group.isAggregateGroup && (
                            <button 
                              className="folio-expand-badge-btn"
                              onClick={(e) => toggleExpand(group.positionKey, e)}
                            >
                              {group.folioCount} folios {isExpanded ? '▲' : '▼'}
                            </button>
                          )}
                          {group.ownershipTag !== 'PERSONAL' && group.ownershipTag !== 'MIXED_HOLDING' && (
                            <span className={`ownership-pill platform-tag ${group.ownershipTag.toLowerCase()}`}>
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
                        {(() => {
                          const groupXirr = computePositionXIRR(group, val);
                          return groupXirr !== null ? (
                            <span className={`sec-val font-semibold num-tabular ${getPnlClass(groupXirr)}`}>
                              {formatSignedPercent(groupXirr)}
                            </span>
                          ) : (
                            <span className="sec-val text-muted">—</span>
                          );
                        })()}
                      </div>
                    </div>

                    {/* 3. Three-Column Primary Metadata Grid */}
                    <div className="card-metadata-grid grid-3 mt-2 font-xs text-muted">
                      <div className="meta-col">
                        <span className="meta-lbl block">{metrics.priceLabel}</span>
                        {(() => {
                          const assetType = detectAssetType(group);
                          const dailyChange = isValued && typeof val.nav === 'number'
                            ? getTodaysChange(val.nav, val.previousClose, assetType, group.currentUnits, oneDayDisplayMode)
                            : null;
                          return (
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', flexWrap: 'wrap' }}>
                              <span className="meta-val font-bold text-primary num-tabular">
                                {isValued && typeof val.nav === 'number' ? `₹${val.nav.toFixed(2)}` : '—'}
                              </span>
                              {dailyChange ? (
                                <span 
                                  className={`todays-change font-semibold num-tabular ${dailyChange.cls}`} 
                                  style={{ fontSize: '0.68rem', color: dailyChange.color, whiteSpace: 'nowrap', cursor: 'pointer' }} 
                                  title="Tap 1D change to switch between price/NAV change and position 1D P&L."
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (onToggleOneDayDisplayMode) onToggleOneDayDisplayMode(e);
                                  }}
                                >
                                  {dailyChange.text}
                                </span>
                              ) : (isValued && typeof val.nav === 'number' ? (
                                <span className="todays-change text-muted font-semibold num-tabular" style={{ fontSize: '0.68rem', whiteSpace: 'nowrap' }}>
                                  —
                                </span>
                              ) : null)}
                            </div>
                          );
                        })()}
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


