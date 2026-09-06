import React, { useState, useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';
import { defaultValuationProvider } from '../../../utils/valuationProvider.js';
import { 
  getInvestmentDisplayMetrics, 
  formatAsOfDate, 
  formatSignedCurrency, 
  formatSignedPercent,
  calculateInvestmentAge,
  getPnlClass
} from '../../../utils/portfolioAggregation.js';

export default function HoldingDetailSheet({ position, valuationProvider, valuationVersion, valuation, onClose, onSelectTxn }) {
  if (!position) return null;

  // Resolve the valuation provider instance reliably
  const provider = valuationProvider || (valuation && typeof valuation.getValuation === 'function' ? valuation : defaultValuationProvider);

  const isAggregated = position.isAggregateGroup && Array.isArray(position.underlyingPositions) && position.underlyingPositions.length > 1;
  const underlyingPositions = isAggregated ? position.underlyingPositions : [position];

  // Folio selector index: 'all' or numeric string index of underlyingPositions
  const [selectedFolioKey, setSelectedFolioKey] = useState('all');
  const [activeTab, setActiveTab] = useState('txns'); // 'txns' | 'fifo' | 'accounting'

  // Determine active view object (either aggregated scheme position or single selected folio)
  const isViewingAll = selectedFolioKey === 'all' || !isAggregated;
  const activeFolioPos = isViewingAll 
    ? null 
    : underlyingPositions[parseInt(selectedFolioKey, 10)];

  const displayPos = activeFolioPos || position;

  // Fetch valuation for the currently active view position
  const activeValuation = provider ? provider.getValuation(displayPos) : displayPos.valuation;
  const isValued = activeValuation && activeValuation.isValued;
  const metrics = getInvestmentDisplayMetrics(displayPos, activeValuation);

  // Compute investment age for current holding / selected folio
  const earliestDate = useMemo(() => {
    const txns = isViewingAll
      ? (position.txns || underlyingPositions.flatMap(p => p.txns || p.transactions || p.allTransactions || []))
      : (activeFolioPos?.txns || activeFolioPos?.transactions || activeFolioPos?.allTransactions || []);
    if (!txns || txns.length === 0) return null;
    const dates = txns.map(t => t.date || t.Date).filter(Boolean);
    return dates.sort()[0] || null;
  }, [isViewingAll, position, underlyingPositions, activeFolioPos]);

  const ageInfo = calculateInvestmentAge(earliestDate);

  // Filter transactions and FIFO lots
  const displayTxns = useMemo(() => {
    if (isViewingAll) {
      if (Array.isArray(position.txns) && position.txns.length > 0) {
        return position.txns;
      }
      return underlyingPositions.flatMap(p => p.txns || p.transactions || p.allTransactions || []);
    }
    return activeFolioPos?.txns || activeFolioPos?.transactions || activeFolioPos?.allTransactions || [];
  }, [isViewingAll, position, underlyingPositions, activeFolioPos]);

  const displayLots = useMemo(() => {
    if (isViewingAll) {
      if (Array.isArray(position.buyLots) && position.buyLots.length > 0) {
        return position.buyLots;
      }
      return underlyingPositions.flatMap(p => p.buyLots || p.fifoLots || []);
    }
    return activeFolioPos?.buyLots || activeFolioPos?.fifoLots || [];
  }, [isViewingAll, position, underlyingPositions, activeFolioPos]);

  const sortedTxns = useMemo(() => {
    return [...displayTxns].sort((a, b) => {
      const parseD = (str) => {
        if (!str) return 0;
        const pts = String(str).split(/[-/]/);
        if (pts.length === 3) {
          if (pts[0].length === 4) return new Date(pts[0], pts[1] - 1, pts[2]).getTime();
          return new Date(pts[2], pts[1] - 1, pts[0]).getTime();
        }
        return new Date(str || 0).getTime() || 0;
      };
      return parseD(b.date) - parseD(a.date);
    });
  }, [displayTxns]);

  return (
    <div className="investments-portfolio-screen fund-detail-fullpage">
      {/* Full Page Top Navigation Bar */}
      <div className="portfolio-top-bar">
        <button className="portfolio-back-btn" onClick={onClose} title="Back to Portfolio">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="20" height="20">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="portfolio-top-titles">
          <h2 className="portfolio-main-title">{position.note || position.security}</h2>
          <div className="portfolio-main-subtitle text-muted flex-gap-xs align-center">
            {ageInfo.fullStr && <span className="age-text">{ageInfo.fullStr} · </span>}
            <span className="platform-tag">{displayPos.subAccount || position.subAccount}</span>
            {(displayPos.ownershipTag === 'MIXED_HOLDING' || position.ownershipTag === 'MIXED_HOLDING') && (
              <span className="platform-tag mixed-tag">MIXED HOLDING</span>
            )}
            {!isAggregated && displayPos.folioNumber && (
              <span className="folio-text mono text-muted">Folio {displayPos.folioNumber}</span>
            )}
          </div>
        </div>
      </div>

      <div className="portfolio-scrollable-content">
        {/* Groww-Inspired 2x2 Performance Summary Hero */}
        <div className="groww-summary-card">
          <div className="summary-grid-2x2">
            <div className="summary-cell">
              <div className="summary-lbl text-muted uppercase">{metrics.valueLabel}</div>
              <div className={`summary-hero-val font-bold num-tabular mt-1 ${isValued ? getPnlClass(activeValuation.currentValue - displayPos.remainingCostBasis) : ''}`}>
                {isValued ? formatINR(activeValuation.currentValue) : <span className="val-na text-muted">{metrics.unvaluedLabel}</span>}
              </div>
            </div>
            <div className="summary-cell text-right">
              <div className="summary-lbl text-muted uppercase">{metrics.returnLabel}</div>
              {isValued ? (
                <div className={`summary-hero-val font-bold num-tabular mt-1 ${getPnlClass(activeValuation.unrealizedPnl)}`}>
                  {formatSignedCurrency(activeValuation.unrealizedPnl)}
                  <span className="pnl-pct-badge font-semibold ml-1">
                    ({formatSignedPercent(activeValuation.returnPercent)})
                  </span>
                </div>
              ) : (
                <div className="summary-hero-val text-muted mt-1">—</div>
              )}
            </div>

            <div className="summary-cell mt-3">
              <div className="summary-lbl text-muted uppercase">{metrics.costLabel}</div>
              <div className="summary-val font-bold num-tabular mt-1">{formatINR(displayPos.remainingCostBasis)}</div>
            </div>
            <div className="summary-cell text-right mt-3">
              <div className="summary-lbl text-muted uppercase">XIRR</div>
              <div className={`summary-val font-bold num-tabular mt-1 ${isValued && metrics.isMf && typeof activeValuation.returnPercent === 'number' ? getPnlClass(activeValuation.returnPercent) : 'text-muted'}`}>
                {isValued && metrics.isMf && typeof activeValuation.returnPercent === 'number' 
                  ? formatSignedPercent(activeValuation.returnPercent)
                  : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* 3-Column Primary Metadata Grid */}
        <div className="groww-nav-bar grid-3">
          <div className="nav-col">
            <span className="nav-lbl text-muted block">{metrics.priceLabel}</span>
            <span className="nav-val font-bold text-primary block num-tabular mt-1">
              {isValued && typeof activeValuation.nav === 'number' ? `₹${activeValuation.nav.toFixed(2)}` : '—'}
            </span>
            {isValued && activeValuation?.asOf && (
              <span className="nav-date block text-muted font-xs mt-1.5">
                As of {formatAsOfDate(activeValuation.asOf)}{activeValuation?.asOfTime ? `, ${activeValuation.asOfTime}` : ''}
              </span>
            )}
          </div>

          <div className="nav-col">
            <span className="nav-lbl text-muted block">{metrics.avgPriceLabel}</span>
            <span className="nav-val font-semibold block num-tabular mt-1">
              {metrics.formattedAvgPrice.replace(/^(Avg NAV|Avg Price)\s*/, '')}
            </span>
          </div>

          <div className="nav-col text-right">
            <span className="nav-lbl text-muted block">{metrics.qtyLabel}</span>
            <span className="nav-val font-semibold block num-tabular mt-1">
              {metrics.rawQty || metrics.formattedQty}
            </span>
          </div>
        </div>

        {/* Folios Selector ("All folios" vs Individual Folio for Multi-Folio schemes) */}
        {isAggregated ? (
          <div className="sheet-card-section">
            <div className="sheet-section-title flex-between">
              <span className="font-bold text-muted uppercase font-xs">FOLIOS ({underlyingPositions.length})</span>
              <span className="font-xs text-muted">Select to view individual folio</span>
            </div>

            <div className="folio-selector-tabs mt-2">
              <button
                className={`folio-tab-btn ${selectedFolioKey === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedFolioKey('all')}
              >
                All folios · {formatINR(position.remainingCostBasis)}
              </button>
              {underlyingPositions.map((p, idx) => (
                <button
                  key={p.positionKey || idx}
                  className={`folio-tab-btn ${selectedFolioKey === String(idx) ? 'active' : ''}`}
                  onClick={() => setSelectedFolioKey(String(idx))}
                >
                  Folio {p.folioNumber}
                </button>
              ))}
            </div>

            {/* Folio Breakdown Cards */}
            <div className="folio-breakdown-list mt-3">
              {underlyingPositions.map((p, idx) => {
                const isSelected = selectedFolioKey === String(idx);
                const pVal = provider ? provider.getValuation(p) : p.valuation;
                const pIsValued = pVal && pVal.isValued;
                const pMetrics = getInvestmentDisplayMetrics(p);

                return (
                  <div
                    key={p.positionKey || idx}
                    className={`folio-breakdown-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedFolioKey(String(idx))}
                  >
                    <div className="folio-card-top flex-between mb-2">
                      <div>
                        <div className="font-bold text-sm">Folio {p.folioNumber}</div>
                        <div className="text-muted font-xs mt-0.5">{p.subAccount}</div>
                      </div>
                      {isSelected && <span className="folio-selected-tag font-xs">Active View</span>}
                    </div>
                    
                    {/* 3-Column Folio Details Grid */}
                    <div className="folio-card-metrics grid-3 font-xs pt-2 border-top">
                      <div>
                        <span className="text-muted block">Units</span>
                        <span className="font-semibold num-tabular block mt-0.5">{pMetrics.rawQty}</span>
                      </div>
                      <div>
                        <span className="text-muted block">Invested</span>
                        <span className="font-semibold num-tabular block mt-0.5">{formatINR(p.remainingCostBasis)}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-muted block">Current Value</span>
                        <span className="font-bold num-tabular block mt-0.5 text-primary">
                          {pIsValued ? formatINR(pVal.currentValue) : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="sheet-card-section grid-2 font-xs">
            <div>
              <span className="text-muted block uppercase">Folio Number</span>
              <span className="font-semibold text-primary mono block mt-1">{position.folioNumber || 'Single Folio'}</span>
            </div>
            <div className="text-right">
              <span className="text-muted block uppercase">Platform</span>
              <span className="font-semibold text-primary block mt-1">{position.subAccount}</span>
            </div>
          </div>
        )}

        {/* Content Navigation Tabs: Transaction History | FIFO Lots | Accounting */}
        <div className="detail-tab-bar">
          <button 
            className={`detail-tab ${activeTab === 'txns' ? 'active' : ''}`}
            onClick={() => setActiveTab('txns')}
          >
            Transaction History ({sortedTxns.length})
          </button>
          <button 
            className={`detail-tab ${activeTab === 'fifo' ? 'active' : ''}`}
            onClick={() => setActiveTab('fifo')}
          >
            FIFO Lots ({displayLots.length})
          </button>
          <button 
            className={`detail-tab ${activeTab === 'accounting' ? 'active' : ''}`}
            onClick={() => setActiveTab('accounting')}
          >
            Accounting
          </button>
        </div>

        {/* Tab 1: Transaction History */}
        {activeTab === 'txns' && (
          <div className="sheet-card-section">
            {sortedTxns.length === 0 ? (
              <div className="portfolio-empty-state font-xs text-muted">No transactions recorded for this view.</div>
            ) : (
              <>
                {/* Desktop Table View */}
                <div className="sheet-lots-table-wrap desktop-only">
                  <table className="sheet-lots-table groww-txn-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th style={{ textAlign: 'right' }}>{metrics.qtyLabel}</th>
                        <th style={{ textAlign: 'right' }}>{metrics.priceLabel} / Unit Price</th>
                        <th style={{ textAlign: 'right' }}>Amount / Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedTxns.map((t, idx) => {
                        const isBuy = t.action === 'BUY' || String(t.InvestmentTransactionType || '').toUpperCase() === 'BUY';
                        const actionLbl = metrics.isMf ? (isBuy ? 'INVESTED' : 'REDEEMED') : (isBuy ? 'BOUGHT' : 'SOLD');

                        const rawUnits = t.units !== undefined && t.units !== null 
                          ? t.units 
                          : (t.quantity !== undefined && t.quantity !== null 
                            ? t.quantity 
                            : (t.PositionQuantityChange !== undefined && t.PositionQuantityChange !== null 
                              ? Math.abs(t.PositionQuantityChange) 
                              : (t.Quantity !== undefined ? Math.abs(t.Quantity) : 0)));
                              
                        const parsedUnits = Math.abs(parseFloat(rawUnits) || 0);
                        const formattedUnitsStr = isNaN(parsedUnits) 
                          ? '—' 
                          : (metrics.isMf ? parsedUnits.toFixed(3) : Math.round(parsedUnits).toString());

                        const rawUnitPrice = t.unitPrice !== undefined && t.unitPrice !== null 
                          ? t.unitPrice 
                          : (t.UnitPrice !== undefined ? t.UnitPrice : 0);
                        const parsedPrice = parseFloat(rawUnitPrice) || 0;
                        const priceStr = parsedPrice > 0 ? `₹${parsedPrice.toFixed(2)}` : '—';

                        const rawTradeVal = t.tradeValue !== undefined && t.tradeValue !== null 
                          ? t.tradeValue 
                          : (t.costBasis !== undefined && t.costBasis !== null 
                            ? t.costBasis 
                            : (t.TradeValue !== undefined ? t.TradeValue : (t.Amount !== undefined ? Math.abs(t.Amount) : 0)));
                        const parsedVal = Math.abs(parseFloat(rawTradeVal) || 0);
                        const tradeValStr = formatINR(parsedVal);

                        const isPosAmount = metrics.isMf ? isBuy : !isBuy;
                        const amountSign = metrics.isMf ? '+' : (isBuy ? '-' : '+');
                        const pnlClass = isPosAmount ? 'pos' : 'neg';

                        return (
                          <tr key={t.rawTxn?.ID || t.id || idx}>
                            <td>{t.date}</td>
                            <td>
                              <span className={`txn-type-pill ${isBuy ? 'buy' : 'sell'}`}>
                                {actionLbl}
                              </span>
                            </td>
                            <td style={{ textAlign: 'right' }} className={`mono font-bold num-tabular ${isBuy ? 'pos' : 'neg'}`}>
                              {isBuy ? '+' : '-'}{formattedUnitsStr}
                            </td>
                            <td style={{ textAlign: 'right' }} className="mono text-muted num-tabular">
                              {priceStr}
                            </td>
                            <td style={{ textAlign: 'right' }} className={`font-bold num-tabular ${pnlClass}`}>
                              {amountSign}{tradeValStr}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card List View — Redesigned Mobile Transactions */}
                <div className="mobile-txn-list mobile-only">
                  {sortedTxns.map((t, idx) => {
                    const isBuy = t.action === 'BUY' || String(t.InvestmentTransactionType || '').toUpperCase() === 'BUY';
                    const actionLbl = metrics.isMf ? (isBuy ? 'INVESTED' : 'REDEEMED') : (isBuy ? 'BOUGHT' : 'SOLD');

                    const rawUnits = t.units !== undefined && t.units !== null 
                      ? t.units 
                      : (t.quantity !== undefined && t.quantity !== null 
                        ? t.quantity 
                        : (t.PositionQuantityChange !== undefined && t.PositionQuantityChange !== null 
                          ? Math.abs(t.PositionQuantityChange) 
                          : (t.Quantity !== undefined ? Math.abs(t.Quantity) : 0)));
                          
                    const parsedUnits = Math.abs(parseFloat(rawUnits) || 0);
                    const qtyStr = isNaN(parsedUnits) 
                      ? '—' 
                      : (metrics.isMf ? `${parsedUnits.toFixed(3)} units` : `${Math.round(parsedUnits)} Qty`);

                    const rawUnitPrice = t.unitPrice !== undefined && t.unitPrice !== null 
                      ? t.unitPrice 
                      : (t.UnitPrice !== undefined ? t.UnitPrice : 0);
                    const parsedPrice = parseFloat(rawUnitPrice) || 0;
                    const priceStr = parsedPrice > 0 ? `₹${parsedPrice.toFixed(2)}` : '—';

                    const rawTradeVal = t.tradeValue !== undefined && t.tradeValue !== null 
                      ? t.tradeValue 
                      : (t.costBasis !== undefined && t.costBasis !== null 
                        ? t.costBasis 
                        : (t.TradeValue !== undefined ? t.TradeValue : (t.Amount !== undefined ? Math.abs(t.Amount) : 0)));
                    const parsedVal = Math.abs(parseFloat(rawTradeVal) || 0);
                    const tradeValStr = formatINR(parsedVal);

                    const isPosAmount = metrics.isMf ? isBuy : !isBuy;
                    const amountSign = metrics.isMf ? '+' : (isBuy ? '-' : '+');
                    const pnlClass = isPosAmount ? 'pos' : 'neg';

                    return (
                      <div key={t.rawTxn?.ID || t.id || idx} className="mobile-txn-card flex-between">
                        <div>
                          <div className="txn-primary-type">
                            <span className={`txn-action-tag ${isBuy ? 'buy' : 'sell'}`}>
                              {actionLbl}
                            </span>
                          </div>
                          <div className="txn-date text-muted font-xs mt-1">{t.date}</div>
                          <div className="txn-sub-meta text-muted font-xs mt-0.5 num-tabular">
                            <span className="mono">{qtyStr}</span>
                            <span> · </span>
                            <span className="mono">{metrics.isMf ? 'NAV' : 'Price'} {priceStr}</span>
                          </div>
                        </div>
                        <div className="text-right align-self-start">
                          <div className={`txn-amount font-bold num-tabular ${pnlClass}`}>
                            {amountSign}{tradeValStr}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Tab 2: Acquisition Lots (FIFO) */}
        {activeTab === 'fifo' && (
          <div className="sheet-card-section">
            <div className="fifo-helper-header text-muted font-xs mb-3">
              Acquisition lots used for cost-basis calculation
            </div>
            {displayLots.length === 0 ? (
              <div className="portfolio-empty-state font-xs text-muted">No active FIFO lots for this view.</div>
            ) : (
              <>
                {/* Mobile View: Dedicated Lot Cards */}
                <div className="mobile-fifo-list mobile-only">
                  {displayLots.map((lot, idx) => (
                    <div key={lot.transactionId || idx} className="fifo-lot-card mb-2">
                      <div className="fifo-card-header flex-between">
                        <div>
                          <span className="text-muted font-xs block uppercase">Acquired</span>
                          <span className="font-bold text-primary font-sm">{lot.date}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-muted font-xs block uppercase">Original Cost</span>
                          <span className="font-bold num-tabular font-sm">{formatINR(lot.costBasis)}</span>
                        </div>
                      </div>

                      <div className="fifo-card-body grid-2 font-xs mt-2 pt-2 border-top">
                        <div>
                          <span className="text-muted block">Original Units</span>
                          <span className="font-semibold num-tabular block mt-0.5">
                            {metrics.isMf ? lot.units.toFixed(3) : Math.round(lot.units)}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-muted block">{metrics.isMf ? 'Original NAV' : 'Acq. Price'}</span>
                          <span className="font-semibold num-tabular block mt-0.5">
                            ₹{lot.unitCost.toFixed(metrics.isMf ? 4 : 2)}
                          </span>
                        </div>
                        <div className="mt-2">
                          <span className="text-muted block">Remaining Units</span>
                          <span className={`font-bold num-tabular block mt-0.5 ${lot.remainingUnits > 0 ? 'pos' : 'text-muted'}`}>
                            {metrics.isMf ? lot.remainingUnits.toFixed(3) : Math.round(lot.remainingUnits)}
                          </span>
                        </div>
                        <div className="text-right mt-2">
                          <span className="text-muted block">Remaining Cost Basis</span>
                          <span className="font-bold num-tabular block mt-0.5">
                            {formatINR(lot.remainingCostBasis !== undefined ? lot.remainingCostBasis : (lot.remainingUnits * lot.unitCost))}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop View: Comprehensive Table */}
                <div className="sheet-lots-table-wrap desktop-only">
                  <table className="sheet-lots-table fifo-table">
                    <thead>
                      <tr>
                        <th>Acquisition Date</th>
                        <th style={{ textAlign: 'right' }}>Original Units</th>
                        <th style={{ textAlign: 'right' }}>{metrics.isMf ? 'Original NAV' : 'Acq. Price'}</th>
                        <th style={{ textAlign: 'right' }}>Original Cost</th>
                        <th style={{ textAlign: 'right' }}>Remaining Units</th>
                        <th style={{ textAlign: 'right' }}>Remaining Cost Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayLots.map((lot, idx) => (
                        <tr key={lot.transactionId || idx}>
                          <td>{lot.date}</td>
                          <td style={{ textAlign: 'right' }} className="num-tabular">
                            {metrics.isMf ? lot.units.toFixed(3) : Math.round(lot.units)}
                          </td>
                          <td style={{ textAlign: 'right' }} className="num-tabular">₹{lot.unitCost.toFixed(metrics.isMf ? 4 : 2)}</td>
                          <td style={{ textAlign: 'right' }} className="num-tabular">{formatINR(lot.costBasis)}</td>
                          <td style={{ textAlign: 'right' }} className={`num-tabular font-bold ${lot.remainingUnits > 0 ? 'pos' : 'text-muted'}`}>
                            {metrics.isMf ? lot.remainingUnits.toFixed(3) : Math.round(lot.remainingUnits)}
                          </td>
                          <td style={{ textAlign: 'right' }} className="num-tabular font-bold">
                            {formatINR(lot.remainingCostBasis !== undefined ? lot.remainingCostBasis : (lot.remainingUnits * lot.unitCost))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* Tab 3: Accounting */}
        {activeTab === 'accounting' && (
          <div className="sheet-card-section">
            <div className="sheet-grid-2">
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">Platform / SubAccount</span>
                <span className="sheet-row-val highlight">{displayPos.subAccount}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">Investment Account</span>
                <span className="sheet-row-val">{displayPos.investmentAccount}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">ISIN</span>
                <span className="sheet-row-val mono">{displayPos.isin}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">Folio Number</span>
                <span className="sheet-row-val mono">{displayPos.folioNumber}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">Holding Mode</span>
                <span className="sheet-row-val">{displayPos.holdingMode}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">Ownership Scope</span>
                <span className="sheet-row-val">{displayPos.ownershipTag === 'MIXED_HOLDING' ? 'Mixed Holding' : (displayPos.ownershipTag || 'Individual')}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">Realized P&L</span>
                <span className="sheet-row-val num-tabular">
                  {displayPos.realizedPnl !== 0 ? (
                    <span className={displayPos.realizedPnl > 0 ? 'pos' : 'neg'}>
                      {displayPos.realizedPnl > 0 ? '+' : ''}{formatINR(displayPos.realizedPnl)}
                    </span>
                  ) : '₹0.00'}
                </span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl text-muted">Accounting Method</span>
                <span className="sheet-row-val">First-In, First-Out (FIFO)</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

