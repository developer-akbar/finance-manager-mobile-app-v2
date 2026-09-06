import React from 'react';
import { formatINR } from '../../../utils/format.js';

export default function HoldingDetailSheet({ position, valuation, onClose, onSelectTxn }) {
  if (!position) return null;

  const isValued = valuation && valuation.isValued;
  const lots = position.buyLots || [];

  return (
    <div className="portfolio-modal-overlay" onClick={onClose}>
      <div className="portfolio-detail-sheet" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="portfolio-sheet-header">
          <div className="portfolio-sheet-title-box">
            <div className="portfolio-sheet-tag">
              <span className={`status-badge ${position.status.toLowerCase()}`}>
                {position.status}
              </span>
              <span className="ownership-badge">
                {position.ownershipTag}
              </span>
              <span className="mode-badge">
                {position.holdingMode}
              </span>
            </div>
            <h3 className="portfolio-sheet-title">{position.note || position.security}</h3>
            <div className="portfolio-sheet-sub">{position.security}</div>
          </div>
          <button className="portfolio-sheet-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="portfolio-sheet-body">
          {/* Top Metrics Banner */}
          <div className="portfolio-sheet-metrics-banner">
            <div className="sheet-metric-col">
              <div className="sheet-metric-lbl">Active Units</div>
              <div className="sheet-metric-val">{position.currentUnits.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</div>
            </div>
            <div className="sheet-metric-divider" />
            <div className="sheet-metric-col">
              <div className="sheet-metric-lbl">Remaining Cost</div>
              <div className="sheet-metric-val">{formatINR(position.remainingCostBasis)}</div>
            </div>
            <div className="sheet-metric-divider" />
            <div className="sheet-metric-col">
              <div className="sheet-metric-lbl">Current Value</div>
              <div className="sheet-metric-val">
                {isValued ? formatINR(valuation.currentValue) : <span className="val-na">—</span>}
              </div>
            </div>
          </div>

          {/* Section: Basic & Technical Identity */}
          <div className="sheet-card-section">
            <div className="sheet-section-title">Identity & Account Details</div>
            <div className="sheet-grid-2">
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Platform / SubAccount</span>
                <span className="sheet-row-val highlight">{position.subAccount}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Investment Account</span>
                <span className="sheet-row-val">{position.investmentAccount}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">ISIN</span>
                <span className="sheet-row-val mono">{position.isin}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Folio Number</span>
                <span className="sheet-row-val mono">{position.folioNumber}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Holding Mode</span>
                <span className="sheet-row-val">{position.holdingMode}</span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Avg Cost / Unit</span>
                <span className="sheet-row-val">₹{position.averageCostPerUnit.toFixed(4)}</span>
              </div>
            </div>
          </div>

          {/* Section: Valuation & Performance */}
          <div className="sheet-card-section">
            <div className="sheet-section-title">Valuation & Returns</div>
            <div className="sheet-grid-2">
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Current NAV</span>
                <span className="sheet-row-val">
                  {isValued ? `₹${valuation.nav.toFixed(4)}` : <span className="text-muted">Unavailable</span>}
                </span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Unrealized P&L</span>
                <span className="sheet-row-val">
                  {isValued ? (
                    <span className={valuation.unrealizedPnl >= 0 ? 'pos' : 'neg'}>
                      {valuation.unrealizedPnl >= 0 ? '+' : ''}{formatINR(valuation.unrealizedPnl)} ({valuation.returnPercent >= 0 ? '+' : ''}{valuation.returnPercent.toFixed(2)}%)
                    </span>
                  ) : <span className="text-muted">Unavailable</span>}
                </span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Realized P&L</span>
                <span className="sheet-row-val">
                  {position.realizedPnl !== 0 ? (
                    <span className={position.realizedPnl > 0 ? 'pos' : 'neg'}>
                      {position.realizedPnl > 0 ? '+' : ''}{formatINR(position.realizedPnl)}
                    </span>
                  ) : '₹0.00'}
                </span>
              </div>
              <div className="sheet-detail-row">
                <span className="sheet-row-lbl">Transaction Activity</span>
                <span className="sheet-row-val">{position.buyCount} BUYs · {position.sellCount} SELLs</span>
              </div>
            </div>
          </div>

          {/* Section: Acquisition Lots (FIFO) */}
          <div className="sheet-card-section">
            <div className="sheet-section-title">
              Acquisition Lots (FIFO) — {lots.length} Tranches
            </div>
            <div className="sheet-lots-table-wrap">
              <table className="sheet-lots-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th style={{ textAlign: 'right' }}>Allotted</th>
                    <th style={{ textAlign: 'right' }}>NAV</th>
                    <th style={{ textAlign: 'right' }}>Remaining</th>
                    <th style={{ textAlign: 'right' }}>Cost Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot, idx) => (
                    <tr key={lot.transactionId || idx}>
                      <td>{lot.date}</td>
                      <td style={{ textAlign: 'right' }}>{lot.units.toFixed(3)}</td>
                      <td style={{ textAlign: 'right' }}>₹{lot.unitCost.toFixed(4)}</td>
                      <td style={{ textAlign: 'right' }} className={lot.remainingUnits > 0 ? 'pos' : 'text-muted'}>
                        {lot.remainingUnits.toFixed(3)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{formatINR(lot.costBasis)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
