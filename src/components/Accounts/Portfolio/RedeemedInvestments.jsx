import React from 'react';
import { formatINR } from '../../../utils/format.js';

export default function RedeemedInvestments({ positions = [], onSelectPosition }) {
  const redeemed = positions.filter(p => p.status === 'REDEEMED');

  if (redeemed.length === 0) {
    return (
      <div className="portfolio-card">
        <div className="portfolio-card-header">
          <h4 className="portfolio-card-title">Redeemed / Closed Investments</h4>
          <div className="portfolio-card-sub">Historical exited positions</div>
        </div>
        <div className="portfolio-empty-state">No redeemed investments found.</div>
      </div>
    );
  }

  return (
    <div className="portfolio-card redeemed-card">
      <div className="portfolio-card-header flex-between">
        <div>
          <h4 className="portfolio-card-title">
            Redeemed / Closed Investments <span className="count-badge">{redeemed.length}</span>
          </h4>
          <div className="portfolio-card-sub">Fully exited positions & historical realized gains/losses</div>
        </div>
      </div>

      <div className="holdings-table-container">
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Fund / Scheme</th>
              <th>Platform</th>
              <th>Folio / Mode</th>
              <th style={{ textAlign: 'right' }}>Units Exited</th>
              <th style={{ textAlign: 'right' }}>Cost Basis</th>
              <th style={{ textAlign: 'right' }}>Realized P&L</th>
              <th style={{ textAlign: 'right' }}>Exit Date</th>
              <th style={{ textAlign: 'center' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {redeemed.map(pos => (
              <tr 
                key={pos.positionKey} 
                className="holdings-table-row clickable"
                onClick={() => onSelectPosition(pos)}
              >
                <td className="fund-cell">
                  <div className="fund-primary-name">{pos.note || pos.security}</div>
                  <div className="fund-secondary-meta mono">{pos.isin}</div>
                </td>
                <td>
                  <span className="platform-tag">{pos.subAccount}</span>
                </td>
                <td>
                  <div className="folio-mode-meta">
                    <span className="folio-text mono">{pos.folioNumber || '—'}</span>
                    <span className="mode-text">{pos.holdingMode}</span>
                  </div>
                </td>
                <td style={{ textAlign: 'right' }} className="mono">
                  {pos.sellUnits > 0 ? pos.sellUnits.toFixed(3) : pos.buyUnits.toFixed(3)}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {formatINR(pos.buyCost || pos.sellCostBasis)}
                </td>
                <td style={{ textAlign: 'right' }} className="font-bold">
                  {pos.realizedPnl !== 0 ? (
                    <span className={pos.realizedPnl > 0 ? 'pos' : 'neg'}>
                      {pos.realizedPnl > 0 ? '+' : ''}{formatINR(pos.realizedPnl)}
                    </span>
                  ) : (
                    '₹0.00'
                  )}
                </td>
                <td style={{ textAlign: 'right' }} className="mono text-muted">
                  {pos.lastTransactionDate || '—'}
                </td>
                <td style={{ textAlign: 'center' }}>
                  <button 
                    className="row-view-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectPosition(pos);
                    }}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
