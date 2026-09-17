import React, { useState, useMemo } from 'react';
import { formatINR, parseDate } from '../../../utils/format.js';

export default function RedeemedInvestments({ positions = [], onSelectPosition }) {
  const [sortKey, setSortKey] = useState('exitDate');
  const [sortDir, setSortDir] = useState('desc'); // 'asc' | 'desc'

  const redeemed = useMemo(() => {
    const list = positions.filter(p => p.status === 'REDEEMED');

    return [...list].sort((a, b) => {
      let comparison = 0;
      if (sortKey === 'name') {
        const nameA = (a.note || a.security || '').toLowerCase();
        const nameB = (b.note || b.security || '').toLowerCase();
        comparison = nameA.localeCompare(nameB);
      } else if (sortKey === 'platform') {
        const pA = (a.subAccount || '').toLowerCase();
        const pB = (b.subAccount || '').toLowerCase();
        comparison = pA.localeCompare(pB);
      } else if (sortKey === 'qty') {
        const qtyA = a.sellUnits > 0 ? a.sellUnits : (a.buyUnits > 0 ? a.buyUnits : a.currentUnits || 0);
        const qtyB = b.sellUnits > 0 ? b.sellUnits : (b.buyUnits > 0 ? b.buyUnits : b.currentUnits || 0);
        comparison = qtyA - qtyB;
      } else if (sortKey === 'cost') {
        const costA = a.buyCost || a.sellCostBasis || 0;
        const costB = b.buyCost || b.sellCostBasis || 0;
        comparison = costA - costB;
      } else if (sortKey === 'pnl') {
        comparison = (a.realizedPnl || 0) - (b.realizedPnl || 0);
      } else if (sortKey === 'exitDate') {
        const dateA = parseDate(a.exitDate || a.lastTransactionDate || 0).getTime();
        const dateB = parseDate(b.exitDate || b.lastTransactionDate || 0).getTime();
        comparison = dateA - dateB;
      }

      return sortDir === 'asc' ? comparison : -comparison;
    });
  }, [positions, sortKey, sortDir]);

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
              <th className="sortable-th" onClick={() => handleHeaderClick('name')}>
                Fund / Scheme{renderSortIndicator('name')}
              </th>
              <th className="sortable-th" onClick={() => handleHeaderClick('platform')}>
                Platform{renderSortIndicator('platform')}
              </th>
              <th>Folio / Mode</th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('qty')}>
                Qty / Units Exited{renderSortIndicator('qty')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('cost')}>
                Cost Basis{renderSortIndicator('cost')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('pnl')}>
                Realized P&L{renderSortIndicator('pnl')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('exitDate')}>
                Exit Date{renderSortIndicator('exitDate')}
              </th>
              <th style={{ textAlign: 'center' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {redeemed.map(pos => {
              const isDemat = pos.investmentAccount === 'Share Market' || pos.holdingMode === 'DEMAT';
              const qty = pos.sellUnits > 0 ? pos.sellUnits : (pos.buyUnits > 0 ? pos.buyUnits : pos.currentUnits);
              const qtyDisplay = isDemat ? `${Math.round(qty)} shares` : `${qty.toFixed(3)} units`;
              const exitDateStr = pos.exitDate || pos.lastTransactionDate || '—';

              return (
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
                  <td style={{ textAlign: 'right' }} className="mono num-tabular">
                    {qtyDisplay}
                  </td>
                  <td style={{ textAlign: 'right' }} className="num-tabular font-semibold">
                    {formatINR(pos.buyCost || pos.sellCostBasis)}
                  </td>
                  <td style={{ textAlign: 'right' }} className="font-bold num-tabular">
                    {pos.realizedPnl !== 0 ? (
                      <span className={pos.realizedPnl > 0 ? 'pos' : 'neg'}>
                        {pos.realizedPnl > 0 ? '+' : ''}{formatINR(pos.realizedPnl)}
                      </span>
                    ) : (
                      '₹0.00'
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono text-muted num-tabular font-semibold">
                    {exitDateStr}
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
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
