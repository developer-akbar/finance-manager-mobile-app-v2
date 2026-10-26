import React, { useState, useMemo } from 'react';
import { DetailSheet } from '../Transactions/TransactionItem.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import { extractProductStockActivity, formatFraction, getDiscreteUnitLabel } from '../../utils/stockActivityHistory.js';
import { formatINR } from '../../utils/format.js';
import './StockActivityDrawer.css';


const getEmoji = (name) => {
  const n = (name || '').toLowerCase();
  if (n.includes('milk') || n.includes('cheese') || n.includes('dairy') || n.includes('butter') || n.includes('paneer')) return '🥛';
  if (n.includes('egg')) return '🥚';
  if (n.includes('apple') || n.includes('banana') || n.includes('mango') || n.includes('fruit') || n.includes('orange')) return '🍎';
  if (n.includes('onion') || n.includes('tomato') || n.includes('potato') || n.includes('garlic') || n.includes('veg')) return '🥕';
  if (n.includes('chicken') || n.includes('meat') || n.includes('fish') || n.includes('mutton')) return '🍗';
  if (n.includes('bread') || n.includes('bun') || n.includes('roti') || n.includes('atta')) return '🍞';
  if (n.includes('rice') || n.includes('dal') || n.includes('wheat') || n.includes('grain')) return '🌾';
  if (n.includes('oil') || n.includes('ghee')) return '🛢️';
  if (n.includes('biscuit') || n.includes('cookie') || n.includes('snack') || n.includes('chips')) return '🍪';
  if (n.includes('chocolate') || n.includes('sweet') || n.includes('sugar') || n.includes('honey')) return '🍬';
  if (n.includes('salt') || n.includes('pepper') || n.includes('masala') || n.includes('spice')) return '🧂';
  if (n.includes('shampoo') || n.includes('soap') || n.includes('wash') || n.includes('paste')) return '🧼';
  return '🥫';
};

export default function StockActivityDrawer({
  product,
  initialBatchId = null,
  batches = [],
  transactions = [],
  inventoryItems = [],
  onClose
}) {
  const productName = typeof product === 'string' ? product : (product?.productName || product?.canonicalProduct || product?.name || '');
  const [selectedBatchId, setSelectedBatchId] = useState(initialBatchId || 'all');
  const [filterType, setFilterType] = useState('all'); // 'all', 'purchase', 'consume', 'lend', 'return', 'installment'
  const [sortOrder, setSortOrder] = useState('newest'); // 'newest' or 'oldest'
  const [compactMode, setCompactMode] = useState(true);
  const [expandedCardIds, setExpandedCardIds] = useState(new Set());
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [inspectTxn, setInspectTxn] = useState(null);
  const [editTxn, setEditTxn] = useState(null);
  const [copyTxn, setCopyTxn] = useState(null);
  const [inspectBaseline, setInspectBaseline] = useState(null);

  // Extract all activity for this product/batch
  const activityData = useMemo(() => {
    return extractProductStockActivity({
      productName,
      selectedBatchId: selectedBatchId === 'all' ? null : selectedBatchId,
      transactions,
      inventoryItems,
      batches
    });
  }, [productName, selectedBatchId, transactions, inventoryItems, batches]);

  const { summary, activities, unmatchedRecords } = activityData;

  // Filter batches available for dropdown
  const productBatches = useMemo(() => {
    const pLow = productName.toLowerCase();
    return (batches || []).filter(b => {
      const bCanon = (b.canonicalProduct || b.cleanedName || b.rawName || '').toLowerCase();
      return bCanon === pLow || bCanon.includes(pLow) || pLow.includes(bCanon);
    });
  }, [batches, productName]);

  // Apply activity type filters
  const filteredActivities = useMemo(() => {
    let list = activities;
    if (filterType === 'purchase') {
      list = list.filter(a => a.type === 'purchase');
    } else if (filterType === 'consume') {
      list = list.filter(a => a.type === 'consume');
    } else if (filterType === 'lend') {
      list = list.filter(a => a.type === 'lend');
    } else if (filterType === 'return') {
      list = list.filter(a => a.type === 'return');
    } else if (filterType === 'installment') {
      list = list.filter(a => a.type === 'installment_payment' || a.installmentInfo);
    }

    if (sortOrder === 'oldest') {
      return [...list].reverse();
    }
    return list;
  }, [activities, filterType, sortOrder]);

  // Counts for filter pills
  const counts = useMemo(() => {
    const c = { all: activities.length, purchase: 0, consume: 0, lend: 0, return: 0, installment: 0 };
    activities.forEach(a => {
      if (a.type === 'purchase') c.purchase++;
      else if (a.type === 'consume') c.consume++;
      else if (a.type === 'lend') c.lend++;
      else if (a.type === 'return') c.return++;
      if (a.type === 'installment_payment' || a.installmentInfo) c.installment++;
    });
    return c;
  }, [activities]);

  const toggleCardExpand = (id) => {
    setExpandedCardIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const emoji = getEmoji(summary.productName);

  return (
    <div className="stock-activity-backdrop" onClick={onClose}>
      <div className="stock-activity-drawer" onClick={e => e.stopPropagation()}>
        {/* 1. Top Header */}
        <div className="stock-act-header">
          <div className="stock-act-title-wrap">
            <span className="stock-act-emoji">{emoji}</span>
            <div style={{ minWidth: 0 }}>
              <div className="stock-act-title" title={summary.productName}>
                {summary.productName}
              </div>
              <div className="stock-act-subtitle">
                <span>Activity & Movement Ledger</span>
                <span>•</span>
                <span style={{
                  color: summary.status === 'In Stock' ? 'var(--green)' :
                         summary.status === 'Out of Stock' ? 'var(--expense)' : 'var(--accent)',
                  fontWeight: 700
                }}>
                  {summary.status}
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="stock-act-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* 2. Pinned Top Controls Area (Never scrolls out of view) */}
        <div className="stock-act-pinned-controls">
          {/* Summary Metrics Grid with Dual-Unit Breakdown */}
          <div className="stock-act-summary-grid">
            <div className="stock-act-sum-card" title="Total purchased stock for this scope">
              <span className="stock-act-sum-lbl">Purchased</span>
              <span className="stock-act-sum-val">
                {formatFraction(summary.totalPurchasedQty)}
                <span className="stock-act-sum-unit">{getDiscreteUnitLabel(summary.totalPurchasedQty, summary)}</span>
              </span>
              {summary.hasPhysicalData && summary.purchasedPhysical && (
                <span className="stock-act-sum-phys">({summary.purchasedPhysical})</span>
              )}
              <span className="stock-act-sum-sub">{formatINR(summary.totalPurchaseValue)}</span>
            </div>

            <div className="stock-act-sum-card" title="Total consumed / used stock">
              <span className="stock-act-sum-lbl">Consumed</span>
              <span className="stock-act-sum-val" style={{ color: 'var(--text-muted)' }}>
                {formatFraction(summary.totalConsumedQty)}
                <span className="stock-act-sum-unit">{getDiscreteUnitLabel(summary.totalConsumedQty, summary)}</span>
              </span>
              {summary.hasPhysicalData && summary.consumedPhysical && (
                <span className="stock-act-sum-phys" style={{ color: 'var(--text-muted)' }}>({summary.consumedPhysical})</span>
              )}
              <span className="stock-act-sum-sub">Used</span>
            </div>

            <div className="stock-act-sum-card" title="Total stock lent to people">
              <span className="stock-act-sum-lbl">Lent</span>
              <span className="stock-act-sum-val" style={{ color: summary.financialDebtOwed > 0 ? '#60a5fa' : 'var(--text-muted)' }}>
                {formatFraction(summary.totalLentQty)}
                <span className="stock-act-sum-unit">{getDiscreteUnitLabel(summary.totalLentQty, summary)}</span>
              </span>
              {summary.hasPhysicalData && summary.lentPhysical && (
                <span className="stock-act-sum-phys" style={{ color: 'var(--text-muted)' }}>({summary.lentPhysical})</span>
              )}
              <span className="stock-act-sum-sub">
                {summary.financialDebtOwed > 0 ? `${formatINR(summary.financialDebtOwed)} owed` : 'Financially Settled'}
              </span>
            </div>

            {summary.totalReturnedQty > 0 && (
              <div className="stock-act-sum-card" title="Stock returned from lending">
                <span className="stock-act-sum-lbl">Returned</span>
                <span className="stock-act-sum-val" style={{ color: '#2dd4bf' }}>
                  {formatFraction(summary.totalReturnedQty)}
                  <span className="stock-act-sum-unit">{getDiscreteUnitLabel(summary.totalReturnedQty, summary)}</span>
                </span>
                <span className="stock-act-sum-sub">Restored</span>
              </div>
            )}

            <div className="stock-act-sum-card highlight" title="Current verified remaining stock">
              <span className="stock-act-sum-lbl">Available Now</span>
              <span className="stock-act-sum-val" style={{ color: summary.currentRemainingQty > 0 ? 'var(--green)' : 'var(--expense)' }}>
                {formatFraction(summary.currentRemainingQty)}
                <span className="stock-act-sum-unit">{getDiscreteUnitLabel(summary.currentRemainingQty, summary)}</span>
              </span>
              {summary.hasPhysicalData && summary.remainingPhysical && (
                <span className="stock-act-sum-phys" style={{ color: summary.currentRemainingQty > 0 ? 'var(--green)' : 'var(--text-muted)' }}>
                  ({summary.remainingPhysical})
                </span>
              )}
              <span className="stock-act-sum-sub">Value: {formatINR(summary.currentRemainingValue)}</span>
            </div>
          </div>

          {/* Scope Selector: Filter to specific batch or all batches */}
          <div className="stock-act-scope-bar">
            <div className="stock-act-scope-meta">
              <span className="stock-act-scope-lbl">Scope:</span>
              <span className="stock-act-scope-badge">{summary.scopeLabel}</span>
            </div>
            {productBatches.length > 1 && (
              <select
                className="stock-act-scope-select"
                value={selectedBatchId}
                onChange={e => setSelectedBatchId(e.target.value)}
              >
                <option value="all">All Batches ({productBatches.length} total)</option>
                {productBatches.map(b => (
                  <option key={b.batchId} value={b.batchId}>
                    {b.purchasedDate} {b.source ? `@ ${b.source}` : ''} ({formatFraction(b.remainingQty)}/{formatFraction(b.purchasedQty)} avail)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Dedicated Filter Section (Unclipped & Accessible) */}
          <div className="stock-act-filter-area">
            <span className="stock-act-filter-title">Filter Activity:</span>
            <div className="stock-act-filters" role="tablist">
              <button
                type="button"
                className={`stock-act-filter-pill ${filterType === 'all' ? 'active' : ''}`}
                onClick={() => setFilterType('all')}
              >
                All Movements ({counts.all})
              </button>
              <button
                type="button"
                className={`stock-act-filter-pill ${filterType === 'purchase' ? 'active' : ''}`}
                onClick={() => setFilterType('purchase')}
              >
                📦 Purchases ({counts.purchase})
              </button>
              <button
                type="button"
                className={`stock-act-filter-pill ${filterType === 'consume' ? 'active' : ''}`}
                onClick={() => setFilterType('consume')}
              >
                🍽️ Consumed ({counts.consume})
              </button>
              {counts.lend > 0 && (
                <button
                  type="button"
                  className={`stock-act-filter-pill ${filterType === 'lend' ? 'active' : ''}`}
                  onClick={() => setFilterType('lend')}
                >
                  🤝 Lent ({counts.lend})
                </button>
              )}
              {counts.return > 0 && (
                <button
                  type="button"
                  className={`stock-act-filter-pill ${filterType === 'return' ? 'active' : ''}`}
                  onClick={() => setFilterType('return')}
                >
                  ↩️ Returns ({counts.return})
                </button>
              )}
              {counts.installment > 0 && (
                <button
                  type="button"
                  className={`stock-act-filter-pill ${filterType === 'installment' ? 'active' : ''}`}
                  onClick={() => setFilterType('installment')}
                >
                  💳 Installments ({counts.installment})
                </button>
              )}
            </div>
          </div>

          {/* Sort Order Toggle, View Mode, & Record Counter Bar */}
          <div className="stock-act-sort-row">
            <div className="stock-act-count-badge">
              Showing <strong>{filteredActivities.length}</strong> verified {filteredActivities.length === 1 ? 'record' : 'records'}
              {unmatchedRecords.length > 0 && (
                <span
                  className="stock-act-unmatched-pill"
                  onClick={() => setShowUnmatched(prev => !prev)}
                  title="Click to inspect excluded / legacy records"
                >
                  • ⚠️ {unmatchedRecords.length} unlinked need review
                </span>
              )}
            </div>
            <div className="stock-act-sort-actions">
              <button
                type="button"
                className={`stock-act-view-mode-btn ${compactMode ? 'active' : ''}`}
                onClick={() => setCompactMode(prev => !prev)}
                title="Toggle between Compact scannable view and Detailed card view"
              >
                {compactMode ? '📋 Detailed' : '🗂️ Compact'}
              </button>
              <button
                type="button"
                className="stock-act-sort-btn"
                onClick={() => setSortOrder(prev => prev === 'newest' ? 'oldest' : 'newest')}
              >
                {sortOrder === 'newest' ? '↓ Newest First' : '↑ Oldest First'}
              </button>
            </div>
          </div>
        </div>

        {/* 3. Independent Scrolling Timeline Area */}
        <div className="stock-act-timeline-scroll">
          {/* Unmatched / Legacy Records Accordion if present */}
          {unmatchedRecords.length > 0 && (
            <div className="stock-act-unmatched-box">
              <div
                className="stock-act-unmatched-header"
                onClick={() => setShowUnmatched(prev => !prev)}
              >
                <div className="stock-act-unmatched-title">
                  <span>⚠️</span>
                  <div>
                    <strong>{unmatchedRecords.length} Legacy Movement{unmatchedRecords.length > 1 ? 's' : ''} Excluded from Balance</strong>
                    <div className="stock-act-unmatched-sub">
                      Kept separate to prevent misattributing stock ({showUnmatched ? 'Click to hide' : 'Click to inspect'})
                    </div>
                  </div>
                </div>
                <button type="button" className="stock-act-unmatched-toggle-btn">
                  {showUnmatched ? 'Hide ▲' : 'Inspect ▼'}
                </button>
              </div>

              {showUnmatched && (
                <div className="stock-act-unmatched-content">
                  <p className="stock-act-unmatched-explanation">
                    These historical transactions mention this product or related stock keywords, but lack a verifiable purchase batch reference. To protect your inventory quantities and running balance from corruption, they are isolated here until reviewed.
                  </p>
                  <div className="stock-act-unmatched-list">
                    {unmatchedRecords.map((rec, rIdx) => (
                      <div key={rec.txnId || rIdx} className="stock-act-unmatched-item">
                        <div className="stock-act-unmatched-item-top">
                          <span className="stock-act-unmatched-date">📅 {rec.date || 'Unknown Date'}</span>
                          <span className="stock-act-unmatched-reason-badge">
                            {rec.reasonLabel || rec.reason || 'Unresolved Batch Reference'}
                          </span>
                        </div>
                        <div className="stock-act-unmatched-desc">{rec.description || 'No description provided'}</div>
                        {rec.tags && <div className="stock-act-unmatched-tags">Tags: {rec.tags}</div>}
                        {rec.rawTxn && (
                          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="stock-act-unmatched-inspect-btn"
                              onClick={() => setInspectTxn(rec.rawTxn)}
                            >
                              🔍 Inspect Transaction
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Timeline List */}
          {filteredActivities.length === 0 ? (
            <div className="stock-act-empty">
              <span className="stock-act-empty-icon">📜</span>
              <span className="stock-act-empty-text">
                {filterType === 'all'
                  ? 'No movement records found for this item yet.'
                  : `No ${filterType} records found for this item.`}
              </span>
            </div>
          ) : (
            <div className="stock-act-timeline">
              {filteredActivities.map((act) => {
                const isPositive = act.qtyDelta > 0;
                const isZero = act.qtyDelta === 0;
                const isExpanded = !compactMode || expandedCardIds.has(act.id);

                return (
                  <div
                    key={act.id}
                    className={`stock-act-item ${compactMode ? 'compact' : ''} ${isExpanded ? 'expanded' : ''}`}
                    onClick={() => compactMode && toggleCardExpand(act.id)}
                  >
                    {/* Primary Line: Type, Date, Delta, Running Balance */}
                    <div className="stock-act-top-row">
                      <div className="stock-act-type-col">
                        <span className={`stock-act-badge ${act.type}`}>
                          {act.type === 'purchase' && '📦 '}
                          {act.type === 'consume' && '🍽️ '}
                          {act.type === 'lend' && '🤝 '}
                          {act.type === 'return' && '↩️ '}
                          {act.type === 'installment_payment' && '💳 '}
                          {act.typeLabel}
                        </span>
                        <span className="stock-act-date">
                          {act.date} {act.time ? `• ${act.time}` : ''}
                        </span>
                      </div>

                      <div className="stock-act-val-col">
                        <span className={`stock-act-delta ${act.type === 'purchase' ? 'positive' : act.type === 'consume' ? 'negative' : act.type === 'lend' ? 'lend' : act.type === 'return' ? 'return' : 'neutral'}`}>
                          {act.qtyStr}
                        </span>
                        <span className="stock-act-bal-pill" title="Verified running stock balance after this transaction">
                          Bal: <strong>{act.balanceStr}</strong>
                        </span>
                      </div>
                    </div>

                    {/* Secondary Line in Compact mode: Quick Chips & Amount */}
                    <div className="stock-act-compact-meta-row">
                      <div className="stock-act-compact-chips">
                        {act.store && <span className="stock-act-tag store">🏪 {act.store}</span>}
                        {act.person && <span className="stock-act-tag person">👤 {act.person}</span>}
                        {act.installmentInfo && <span className="stock-act-tag inst">💳 {act.installmentInfo}</span>}
                        {act.variant && act.variant !== 'Standard' && <span className="stock-act-tag var">🏷️ {act.variant}</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                        {act.amount > 0 && (
                          <span className="stock-act-amount">{formatINR(act.amount)}</span>
                        )}
                        {compactMode && (
                          <button
                            type="button"
                            className="stock-act-expand-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleCardExpand(act.id);
                            }}
                            title={isExpanded ? 'Collapse' : 'Expand'}
                          >
                            {isExpanded ? '▲' : '▼'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Expanded Content (Progressive Disclosure) */}
                    {isExpanded && (
                      <div className="stock-act-expanded-body" onClick={e => e.stopPropagation()}>
                        {/* Concise Accounting and Movement Summary */}
                        <div className="stock-act-concise-summary">
                          <div className="stock-act-summary-line">
                            <span className="stock-act-line-lbl">Money moved:</span>
                            <span className="stock-act-line-val">{act.moneyMovedStr || `${act.fromAccount || 'Account'} → ${act.toAccount || 'Stock'}`}</span>
                          </div>
                          <div className="stock-act-summary-line">
                            <span className="stock-act-line-lbl">Movement:</span>
                            <span className="stock-act-line-val" style={{
                              color: act.type === 'purchase' ? '#4ade80' : act.type === 'consume' ? '#f87171' : act.type === 'lend' ? '#60a5fa' : act.type === 'return' ? '#2dd4bf' : 'var(--text-primary)',
                              fontWeight: 700
                            }}>
                              {act.stockMovementShort || act.inventoryRole || act.typeLabel}
                            </span>
                          </div>
                        </div>

                        {/* Full Description */}
                        {act.description && (
                          <div className="stock-act-desc">
                            <strong>Description:</strong> {act.description}
                          </div>
                        )}

                        {/* Contextual Badges */}
                        <div className="stock-act-meta-tags">
                          {act.batchId && <span className="stock-act-tag">Batch ID: {act.batchId}</span>}
                          {act.batchDate && <span className="stock-act-tag">Batch Date: {act.batchDate}</span>}
                          {act.unitPrice > 0 && <span className="stock-act-tag">Unit Price: ₹{act.unitPrice.toFixed(2)}</span>}
                          {act.note && <span className="stock-act-tag">Note: {act.note}</span>}
                        </div>

                        {/* Action: Inspect Original Transaction or Baseline */}
                        <div className="stock-act-bottom-row">
                          {act.rawTxn ? (
                            <button
                              type="button"
                              className="stock-act-view-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setInspectTxn(act.rawTxn);
                              }}
                            >
                              👁️ View Full Transaction Details
                            </button>
                          ) : act.isHistoricalBaseline ? (
                            <button
                              type="button"
                              className="stock-act-view-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setInspectBaseline(act);
                              }}
                            >
                              ℹ️ View Baseline Derivation Details
                            </button>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Reused Existing Transaction Detail Interface */}
        {inspectTxn && (
          <DetailSheet
            t={inspectTxn}
            onEdit={() => {
              setEditTxn(inspectTxn);
              setInspectTxn(null);
            }}
            onCopy={(copied) => {
              setCopyTxn(copied);
              setInspectTxn(null);
            }}
            onClose={() => setInspectTxn(null)}
          />
        )}

        {/* Reused Existing Add/Edit Transaction Modal */}
        {editTxn && (
          <AddTransaction
            editTransaction={editTxn}
            onClose={() => setEditTxn(null)}
          />
        )}

        {/* Reused Existing Add/Copy Transaction Modal */}
        {copyTxn && (
          <AddTransaction
            copyTransaction={copyTxn}
            onClose={() => setCopyTxn(null)}
          />
        )}

        {/* Baseline Explanation Modal for Synthetic Records */}
        {inspectBaseline && (
          <div
            className="stock-act-inspect-backdrop"
            onClick={() => setInspectBaseline(null)}
          >
            <div
              className="stock-act-inspect-modal animate-pop"
              onClick={e => e.stopPropagation()}
            >
              <div className="stock-act-inspect-header">
                <span className="stock-act-inspect-title">
                  Historical Baseline Details
                </span>
                <button
                  type="button"
                  className="stock-act-inspect-close"
                  onClick={() => setInspectBaseline(null)}
                >
                  ✕
                </button>
              </div>

              <div className="stock-act-inspect-explainer">
                <div className="stock-act-explainer-row">
                  <span className="stock-act-explainer-lbl">Movement Type:</span>
                  <strong style={{ color: '#f87171' }}>
                    Historical Baseline Consumption (Pre-Cutoff)
                  </strong>
                </div>
                <div className="stock-act-explainer-row">
                  <span className="stock-act-explainer-lbl">Audited Batch:</span>
                  <span>{inspectBaseline.batchId} ({inspectBaseline.batchDate || inspectBaseline.date})</span>
                </div>
              </div>

              <div className="stock-act-inspect-body">
                <div><strong>Product:</strong> {summary.productName}</div>
                <div><strong>Movement Quantity:</strong> {inspectBaseline.qtyStr}</div>
                <div><strong>Source / Store:</strong> {inspectBaseline.store || 'Historical Inventory'}</div>
                <div><strong>Variant:</strong> {inspectBaseline.variant || 'Standard'}</div>
                <div className="stock-act-inspect-desc-box">
                  <strong>Accounting Derivation:</strong><br />
                  This movement accounts for stock consumed prior to dynamic per-transaction tracking. It reconciles directly from the inventory batch's audited remaining stock ({inspectBaseline.note || 'audited batch remaining balance'}) without fabricating artificial financial transactions.
                </div>
              </div>

              <div className="stock-act-inspect-footer">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => setInspectBaseline(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
