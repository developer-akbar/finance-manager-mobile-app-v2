import React, { useState, useEffect, useRef } from 'react';
import { formatINR } from '../../utils/format.js';
import './InvestmentPlanPickerModal.css';

export default function InvestmentPlanPickerModal({
  isOpen,
  onClose,
  plans = [],
  onSelectPlan,
}) {
  const [search, setSearch] = useState('');
  const searchInputRef = useRef(null);

  // Auto-focus search on open
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      const t = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Handle Escape / Back key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activePlans = plans.filter((p) => p.active !== false);

  const q = search.trim().toLowerCase();
  const filteredPlans = activePlans.filter((p) => {
    if (!q) return true;
    const name = (p.name || p.security_name || '').toLowerCase();
    const symbol = (p.security_symbol || '').toLowerCase();
    const invAcct = (p.investment_account || '').toLowerCase();
    const fundAcct = (p.funding_account || '').toLowerCase();
    const subAcct = (p.sub_account || p.brokerage || '').toLowerCase();
    return (
      name.includes(q) ||
      symbol.includes(q) ||
      invAcct.includes(q) ||
      fundAcct.includes(q) ||
      subAcct.includes(q)
    );
  });

  return (
    <div className="plan-picker-overlay" onClick={onClose}>
      <div className="plan-picker-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="plan-picker-header">
          <div className="plan-picker-title">
            <span>📊</span> Investment Plans (SIP)
          </div>
          <button className="plan-picker-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {/* Search Field */}
        <div className="plan-picker-search-wrap">
          <span className="plan-picker-search-icon">🔍</span>
          <input
            ref={searchInputRef}
            type="text"
            className="plan-picker-search-input"
            placeholder="Search investment plan..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="plan-picker-search-clear"
              onClick={() => {
                setSearch('');
                searchInputRef.current?.focus();
              }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Scrollable Plans List */}
        <div className="plan-picker-list">
          {filteredPlans.length === 0 ? (
            <div className="plan-picker-empty">
              {activePlans.length === 0 ? (
                <>
                  <div className="plan-picker-empty-icon">📈</div>
                  <div>No active investment plans available.</div>
                </>
              ) : (
                <>
                  <div className="plan-picker-empty-icon">🔍</div>
                  <div>No investment plans matching "{search}"</div>
                </>
              )}
            </div>
          ) : (
            filteredPlans.map((p) => {
              const plannedAmt = p.planned_amount ? parseFloat(p.planned_amount) : 0;
              const formattedAmt = plannedAmt > 0 ? formatINR(plannedAmt) : '';
              const freq = (p.frequency || 'Monthly').charAt(0).toUpperCase() + (p.frequency || 'Monthly').slice(1);
              const invType = (p.investment_type || 'BUY').toUpperCase();

              return (
                <div
                  key={p.id}
                  className="plan-picker-card"
                  onClick={() => onSelectPlan(p)}
                >
                  <div className="plan-picker-card-main">
                    {/* Fund / Security Name */}
                    <div className="plan-picker-card-name" title={p.name}>
                      {p.name}
                    </div>

                    {/* Meta: Amount & Frequency & Badges */}
                    <div className="plan-picker-card-meta">
                      {formattedAmt ? (
                        <span className="plan-picker-amount">{formattedAmt}</span>
                      ) : null}
                      {formattedAmt && <span className="plan-picker-dot">•</span>}
                      <span className="plan-picker-freq">{freq}</span>
                      <span className={`plan-picker-badge ${invType === 'SELL' ? 'sell' : 'buy'}`}>
                        {invType}
                      </span>
                      {p.owner === 'External' && (
                        <span className="plan-picker-badge external">Family</span>
                      )}
                    </div>

                    {/* Routing */}
                    <div className="plan-picker-card-route">
                      {p.funding_account && (
                        <>
                          <span className="route-acct">{p.funding_account}</span>
                          <span className="route-arrow">→</span>
                        </>
                      )}
                      <span className="route-acct">{p.investment_account || 'Investments'}</span>
                      {p.sub_account && (
                        <span className="route-sub">({p.sub_account})</span>
                      )}
                    </div>
                  </div>

                  {/* Use Action Button */}
                  <div className="plan-picker-card-action">
                    <button
                      type="button"
                      className="btn-use-plan"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectPlan(p);
                      }}
                    >
                      Use
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
