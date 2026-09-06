import React, { useState, useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';
import { parseMutualFundTransaction } from '../../../utils/mutualFundPositionEngine.js';
import { parseTxnFields } from '../../../utils/brokerageAccounting.js';

export default function InvestmentActivity({ transactions = [], onSelectTxn }) {
  const [filterAction, setFilterAction] = useState('all'); // 'all' | 'BUY' | 'SELL'

  const activityList = useMemo(() => {
    const list = [];
    for (const t of transactions) {
      // Ignore funding transfers (e.g., Canara → Share Market)
      const typeStr = String(t['Income/Expense'] || t.type || '').trim();
      const descStr = String(t.Description || t.description || '').toLowerCase();
      const noteStr = String(t.Note || t.note || '').toLowerCase();
      if (typeStr.toLowerCase().includes('transfer') || descStr.includes('funding') || noteStr.includes('funding')) {
        continue;
      }

      // 1. Mutual Fund Trade
      const p = parseMutualFundTransaction(t);
      if (p && (p.action === 'BUY' || p.action === 'SELL') && p.isin) {
        list.push({
          id: p.id,
          date: p.date,
          action: p.action,
          security: p.note || p.security,
          subAccount: p.subAccount,
          ownershipTag: p.ownershipTag,
          quantity: p.quantity,
          unitPrice: p.unitPrice,
          amount: p.tradeValue || p.costBasis
        });
        continue;
      }

      // 2. Share Market Trade
      const sm = parseTxnFields(t);
      if (sm && (sm.type === 'BUY' || sm.type === 'SELL') && !sm.isRecon && sm.symbol) {
        list.push({
          id: t.ID || t.id,
          date: t.Date || t.date || '',
          action: sm.type,
          security: sm.symbol,
          subAccount: sm.brokerage || 'Fareeda Groww',
          ownershipTag: 'PERSONAL',
          quantity: sm.qty,
          unitPrice: sm.cost > 0 && sm.qty > 0 ? sm.cost / sm.qty : 0,
          amount: Math.abs(sm.cashImpact) || sm.cost || sm.costBasis
        });
      }
    }

    list.sort((a, b) => {
      const parseD = (s) => {
        const parts = (s || '').split('/');
        if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
        return new Date(s || 0).getTime() || 0;
      };
      return parseD(b.date) - parseD(a.date);
    });

    return list;
  }, [transactions]);

  const filteredActivity = useMemo(() => {
    if (filterAction === 'all') return activityList;
    return activityList.filter(a => a.action === filterAction);
  }, [activityList, filterAction]);

  return (
    <div className="portfolio-card activity-card">
      <div className="portfolio-card-header flex-between">
        <div>
          <h4 className="portfolio-card-title">Recent Investment Activity</h4>
          <div className="portfolio-card-sub">First-class acquisitions and redemptions</div>
        </div>

        <div className="portfolio-pill-selector">
          <button 
            className={`portfolio-pill ${filterAction === 'all' ? 'active' : ''}`}
            onClick={() => setFilterAction('all')}
          >
            All ({activityList.length})
          </button>
          <button 
            className={`portfolio-pill ${filterAction === 'BUY' ? 'active' : ''}`}
            onClick={() => setFilterAction('BUY')}
          >
            BUY
          </button>
          <button 
            className={`portfolio-pill ${filterAction === 'SELL' ? 'active' : ''}`}
            onClick={() => setFilterAction('SELL')}
          >
            SELL
          </button>
        </div>
      </div>

      <div className="activity-list-container">
        {filteredActivity.length === 0 ? (
          <div className="portfolio-empty-state">No investment activity matching filter.</div>
        ) : (
          filteredActivity.slice(0, 25).map((item, idx) => (
            <div key={item.id || idx} className="activity-row">
              <div className="activity-action-col">
                <span className={`activity-badge ${item.action.toLowerCase()}`}>
                  {item.action}
                </span>
              </div>
              <div className="activity-main-col">
                <div className="activity-fund-name">{item.security}</div>
                <div className="activity-meta">
                  <span>{item.date}</span> · 
                  <span className="platform-tag">{item.subAccount}</span>
                  {item.ownershipTag && item.ownershipTag !== 'PERSONAL' && (
                    <span className={`ownership-pill ${item.ownershipTag.toLowerCase()}`}>
                      {item.ownershipTag}
                    </span>
                  )}
                </div>
              </div>
              <div className="activity-units-col mono">
                <div className="activity-units-val">
                  {item.quantity > 0 ? item.quantity.toFixed(3) : '—'} units
                </div>
                <div className="activity-nav-val">
                  {item.unitPrice > 0 ? `@ ₹${item.unitPrice.toFixed(2)}` : ''}
                </div>
              </div>
              <div className="activity-amount-col font-bold">
                {formatINR(item.amount)}
              </div>
            </div>
          ))
        )}

        {filteredActivity.length > 25 && (
          <div className="activity-footer-more">
            Showing latest 25 of {filteredActivity.length} investment transactions
          </div>
        )}
      </div>
    </div>
  );
}
