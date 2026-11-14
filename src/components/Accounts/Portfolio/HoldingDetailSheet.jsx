import React, { useState, useEffect, useRef, useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';
import { defaultValuationProvider, detectAssetType } from '../../../utils/valuationProvider.js';
import { parseTxnFields } from '../../../utils/brokerageAccounting.js';
import {
  getInvestmentDisplayMetrics,
  formatAsOfDate,
  formatSignedCurrency,
  formatSignedPercent,
  getPnlClass,
  computePositionXIRR,
  getTodaysChange
} from '../../../utils/portfolioAggregation.js';

// ── Smart Scrollable Container Component ──────────────────────────────────────
// Hides scrollbar by default; smoothly displays a subtle thumb during active scroll,
// fading out 1000ms after scrolling stops. Zero layout shift.
function SmartScrollContainer({ children, className = '' }) {
  const [isScrolling, setIsScrolling] = useState(false);
  const timerRef = useRef(null);

  const handleScroll = () => {
    setIsScrolling(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setIsScrolling(false);
    }, 1000);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      className={`smart-scrollbar ${isScrolling ? 'is-scrolling' : ''} ${className}`}
      onScroll={handleScroll}
    >
      {children}
    </div>
  );
}

function extractTxnDetails(t, isMf) {
  if (!t) return { isBuy: true, actionLbl: 'Bought', parsedUnits: 0, parsedPrice: 0, parsedVal: 0, date: '', note: '' };

  const f = parseTxnFields(t);

  const rawType = String(
    f?.type ||
    t.action ||
    t.InvestmentTransactionType ||
    t.investment_transaction_type ||
    t.type ||
    ''
  ).toUpperCase();

  const isBuy = rawType.includes('BUY') || rawType.includes('INVEST') || rawType === 'OPENING_LOT';
  const actionLbl = isMf ? (isBuy ? 'Invested' : 'Redeemed') : (isBuy ? 'Bought' : 'Sold');

  let parsedUnits = 0;
  if (f && f.qty > 0) {
    parsedUnits = f.qty;
  } else {
    const qVal = t.units ?? t.Units ?? t.quantity ?? t.Quantity ?? t.PositionQuantityChange ?? t.sellUnits ?? t.buyUnits ?? 0;
    parsedUnits = Math.abs(parseFloat(qVal) || 0);
  }

  let parsedPrice = 0;
  if (t.unitPrice !== undefined && t.unitPrice !== null && t.unitPrice !== '') {
    parsedPrice = parseFloat(t.unitPrice) || 0;
  } else if (t.UnitPrice !== undefined && t.UnitPrice !== null && t.UnitPrice !== '') {
    parsedPrice = parseFloat(t.UnitPrice) || 0;
  } else if (t.price !== undefined && t.price !== null && t.price !== '') {
    parsedPrice = parseFloat(t.price) || 0;
  } else if (f && f.cost > 0 && f.qty > 0) {
    parsedPrice = f.cost / f.qty;
  }

  let parsedVal = 0;
  if (f && (f.cost > 0 || f.cashImpact > 0)) {
    parsedVal = f.cost || f.cashImpact;
  } else {
    const valCandidates = [t.tradeValue, t.TradeValue, t.costBasis, t.CostBasis, t.cashImpact, t.INR, t.inr, t.Amount, t.amount];
    for (const cand of valCandidates) {
      if (cand !== undefined && cand !== null && cand !== '') {
        const p = Math.abs(parseFloat(cand));
        if (!isNaN(p) && p > 0) {
          parsedVal = p;
          break;
        }
      }
    }
  }

  if (parsedPrice === 0 && parsedVal > 0 && parsedUnits > 0) {
    parsedPrice = parsedVal / parsedUnits;
  }
  if (parsedVal === 0 && parsedPrice > 0 && parsedUnits > 0) {
    parsedVal = parsedPrice * parsedUnits;
  }

  const date = t.date || t.Date || t.firstBuyDate || '';
  const note = t.note || t.Note || '';

  return {
    isBuy,
    actionLbl,
    parsedUnits,
    parsedPrice,
    parsedVal,
    date,
    note
  };
}

export default function HoldingDetailSheet({
  position,
  valuationProvider,
  valuationVersion,
  valuation,
  oneDayDisplayMode = 'unit',
  onToggleOneDayDisplayMode = null,
  onClose,
  onSelectTxn
}) {
  if (!position) return null;

  const provider = valuationProvider || (valuation && typeof valuation.getValuation === 'function' ? valuation : defaultValuationProvider);

  const isAggregated = position.isAggregateGroup && Array.isArray(position.underlyingPositions) && position.underlyingPositions.length > 1;
  const underlyingPositions = isAggregated ? position.underlyingPositions : [position];

  const [selectedFolioKey, setSelectedFolioKey] = useState('all');
  const [activeTab, setActiveTab] = useState('fifo'); // 'fifo' | 'txns' | 'accounting' (Default FIFO Lots)

  const isViewingAll = selectedFolioKey === 'all' || !isAggregated;
  const activeFolioPos = isViewingAll
    ? null
    : underlyingPositions[parseInt(selectedFolioKey, 10)];

  const displayPos = activeFolioPos || position;
  const activeValuation = provider ? provider.getValuation(displayPos) : displayPos.valuation;
  const isValued = activeValuation && activeValuation.isValued;
  const metrics = getInvestmentDisplayMetrics(displayPos, activeValuation);

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
    let lots = [];
    if (isViewingAll) {
      if (Array.isArray(position.buyLots) && position.buyLots.length > 0) {
        lots = position.buyLots;
      } else {
        lots = underlyingPositions.flatMap(p => p.buyLots || p.fifoLots || []);
      }
    } else {
      lots = activeFolioPos?.buyLots || activeFolioPos?.fifoLots || [];
    }

    // DISPLAY ORDER ONLY: Latest acquisition date first (descending)
    return [...lots].sort((a, b) => {
      const parseD = (str) => {
        if (!str) return 0;
        const pts = String(str).split(/[-/]/);
        if (pts.length === 3) {
          if (pts[0].length === 4) return new Date(parseInt(pts[0], 10), parseInt(pts[1], 10) - 1, parseInt(pts[2], 10)).getTime();
          return new Date(parseInt(pts[2], 10), parseInt(pts[1], 10) - 1, parseInt(pts[0], 10)).getTime();
        }
        return new Date(str).getTime() || 0;
      };
      return parseD(b.date || b.Date) - parseD(a.date || a.Date);
    });
  }, [isViewingAll, position, underlyingPositions, activeFolioPos]);

  const sortedTxns = useMemo(() => {
    return [...displayTxns].sort((a, b) => {
      const parseD = (str) => {
        if (!str) return 0;
        const pts = String(str).split(/[-/]/);
        if (pts.length === 3) {
          if (pts[0].length === 4) return new Date(parseInt(pts[0], 10), parseInt(pts[1], 10) - 1, parseInt(pts[2], 10)).getTime();
          return new Date(parseInt(pts[2], 10), parseInt(pts[1], 10) - 1, parseInt(pts[0], 10)).getTime();
        }
        return new Date(str).getTime() || 0;
      };
      return parseD(b.date || b.Date) - parseD(a.date || a.Date);
    });
  }, [displayTxns]);

  // Enriched FIFO lots with individual acquisition return % (Current Return)
  const enrichedLots = useMemo(() => {
    const curNav = activeValuation && isValued && typeof activeValuation.nav === 'number'
      ? activeValuation.nav
      : (displayPos.currentNav || null);

    return displayLots.map((lot, idx) => {
      const origUnits = lot.units !== undefined ? lot.units : (lot.qty || lot.quantity || 0);
      const remUnits = lot.remainingUnits !== undefined ? lot.remainingUnits : 0;
      const uCost = lot.unitCost !== undefined ? lot.unitCost : (origUnits > 0 ? lot.costBasis / origUnits : 0);
      const remCost = lot.remainingCostBasis !== undefined ? lot.remainingCostBasis : (remUnits * uCost);
      const origCost = origUnits * uCost;

      const remVal = (curNav !== null && remUnits > 0) ? (remUnits * curNav) : null;
      const pnl = (remVal !== null) ? (remVal - remCost) : null;
      const pnlPct = (pnl !== null && remCost > 0) ? (pnl / remCost) * 100 : null;
      const remPct = origUnits > 0 ? Math.min(100, Math.round((remUnits / origUnits) * 100)) : 0;

      return {
        id: lot.transactionId || idx,
        date: lot.date || lot.Date,
        origUnits,
        remUnits,
        uCost,
        curNav,
        origCost,
        remCost,
        remVal,
        pnl: pnl !== null ? Math.round(pnl * 100) / 100 : null,
        pnlPct: pnlPct !== null ? Math.round(pnlPct * 10) / 10 : null,
        remPct
      };
    });
  }, [displayLots, isValued, activeValuation, displayPos.currentNav]);

  // First Acquired Date and Duration Resolution (Never shows dash when txns or lots exist)
  const firstAcquiredDate = useMemo(() => {
    if (displayPos.firstBuyDate) return displayPos.firstBuyDate;
    if (sortedTxns && sortedTxns.length > 0) {
      const buyTxns = sortedTxns.filter(t => {
        const rawType = String(t.action || t.InvestmentTransactionType || t.investment_transaction_type || t.type || '').toUpperCase();
        return rawType.includes('BUY') || rawType.includes('INVEST') || rawType === 'OPENING_LOT';
      });
      const cand = buyTxns.length > 0 ? buyTxns[buyTxns.length - 1] : sortedTxns[sortedTxns.length - 1];
      const d = cand?.date || cand?.Date;
      if (d) return d;
    }
    if (enrichedLots && enrichedLots.length > 0) {
      return enrichedLots[enrichedLots.length - 1].date;
    }
    return '';
  }, [displayPos.firstBuyDate, sortedTxns, enrichedLots]);

  const ageInfo = useMemo(() => {
    const parseD = (str) => {
      if (!str) return null;
      const pts = String(str).split(/[-/]/);
      if (pts.length === 3) {
        if (pts[0].length === 4) return new Date(parseInt(pts[0], 10), parseInt(pts[1], 10) - 1, parseInt(pts[2], 10));
        return new Date(parseInt(pts[2], 10), parseInt(pts[1], 10) - 1, parseInt(pts[0], 10));
      }
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    };

    let startD = null;
    if (firstAcquiredDate) {
      startD = parseD(firstAcquiredDate);
    }
    if (!startD && sortedTxns && sortedTxns.length > 0) {
      const dates = sortedTxns.map(t => parseD(t.date || t.Date)).filter(Boolean).sort((a, b) => a - b);
      if (dates.length > 0) startD = dates[0];
    }
    if (!startD && enrichedLots && enrichedLots.length > 0) {
      const dates = enrichedLots.map(l => parseD(l.date)).filter(Boolean).sort((a, b) => a - b);
      if (dates.length > 0) startD = dates[0];
    }

    if (!startD) return { fullStr: '' };

    const isRedeemed = displayPos.status === 'REDEEMED';
    let endD = new Date('2026-09-06');
    if (isRedeemed && sortedTxns && sortedTxns.length > 0) {
      const exitDates = sortedTxns.map(t => parseD(t.date || t.Date)).filter(Boolean).sort((a, b) => a - b);
      if (exitDates.length > 0) endD = exitDates[exitDates.length - 1];
    }

    if (isRedeemed && startD.getFullYear() === endD.getFullYear() && startD.getMonth() === endD.getMonth() && startD.getDate() === endD.getDate()) {
      return { fullStr: 'Held: Same day' };
    }

    let years = endD.getFullYear() - startD.getFullYear();
    let months = endD.getMonth() - startD.getMonth();
    if (months < 0) {
      years -= 1;
      months += 12;
    }
    if (endD.getDate() < startD.getDate()) {
      months -= 1;
      if (months < 0) {
        years -= 1;
        months += 12;
      }
    }

    const partsArr = [];
    if (years > 0) partsArr.push(`${years} ${years === 1 ? 'yr' : 'yrs'}`);
    if (months > 0 || years === 0) partsArr.push(`${months} ${months === 1 ? 'mo' : 'mos'}`);

    const prefix = isRedeemed ? 'Held for' : 'Invested for';
    return { fullStr: `${prefix} ${partsArr.join(' ')}` };
  }, [firstAcquiredDate, sortedTxns, enrichedLots, displayPos.status]);

  const exitedUnits = displayPos.sellUnits || displayPos.buyUnits || displayPos.exitedQty || 0;
  const isRedeemed = displayPos.status === 'REDEEMED';

  const avgBuyPriceStr = useMemo(() => {
    if (isRedeemed) {
      const totalCost = displayPos.buyCost || displayPos.soldCostBasis || 0;
      if (totalCost > 0 && exitedUnits > 0) {
        return `₹${(totalCost / exitedUnits).toFixed(2)}`;
      }
      return '—';
    }
    return metrics.formattedAvgPrice ? metrics.formattedAvgPrice.replace(/^(Avg NAV|Avg Price)\s*/, '') : '—';
  }, [isRedeemed, displayPos, exitedUnits, metrics.formattedAvgPrice]);

  const assetType = detectAssetType(displayPos);
  const dailyChange = !isRedeemed && isValued && typeof activeValuation?.nav === 'number'
    ? getTodaysChange(activeValuation.nav, activeValuation.previousClose, assetType, displayPos.currentUnits, oneDayDisplayMode)
    : null;

  const detailXirr = computePositionXIRR(displayPos, activeValuation);

  // ── 1. FIFO LOTS / ACQUISITION LOT ANALYSIS TABLE (With Current Return %) ──
  const renderFifoTable = (isDesktopPanel = false) => {
    if (enrichedLots.length === 0) {
      return (
        <div className="portfolio-empty-state font-xs text-muted">
          No active FIFO lots for this view.
        </div>
      );
    }

    return (
      <div className={`sheet-lots-table-wrap ${isDesktopPanel ? 'desktop-panel-table-wrap' : ''}`}>
        <table className="sheet-lots-table fifo-table detail-fifo-table">
          <thead>
            <tr>
              <th>Acquired</th>
              <th style={{ textAlign: 'right' }}>Acq Qty</th>
              <th style={{ textAlign: 'right' }}>Rem Qty</th>
              <th style={{ textAlign: 'right' }}>{metrics.isMf ? 'NAV' : 'Price'}</th>
              <th style={{ textAlign: 'right' }}>Rem Cost</th>
              <th style={{ textAlign: 'right' }}>Return</th>
            </tr>
          </thead>
          <tbody>
            {enrichedLots.map((lot, idx) => (
              <tr key={lot.id || idx}>
                <td className="num-tabular mono font-semibold">{lot.date}</td>
                <td style={{ textAlign: 'right' }} className="num-tabular mono text-muted">
                  {metrics.isMf ? lot.origUnits.toFixed(3) : Math.round(lot.origUnits)}
                </td>
                <td style={{ textAlign: 'right' }} className={`num-tabular mono font-bold ${lot.remUnits > 0 ? 'pos' : 'text-muted'}`}>
                  {metrics.isMf ? lot.remUnits.toFixed(3) : Math.round(lot.remUnits)}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular mono font-semibold">
                  ₹{lot.uCost.toFixed(2)}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular font-bold text-primary">
                  {formatINR(lot.remCost)}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular font-bold">
                  {lot.pnl !== null ? (
                    <span className={`portfolio-kpi-pill ${getPnlClass(lot.pnl)}`}>
                      {lot.pnlPct >= 0 ? `+${lot.pnlPct.toFixed(1)}%` : `${lot.pnlPct.toFixed(1)}%`}
                    </span>
                  ) : (
                    <span className="text-muted font-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // ── 2. TRANSACTION HISTORY TABLE ──────────────────────────────────────────
  const renderTxnTable = (isDesktopPanel = false) => {
    if (sortedTxns.length === 0) {
      return (
        <div className="portfolio-empty-state font-xs text-muted">
          No transactions recorded for this view.
        </div>
      );
    }

    return (
      <div className={`sheet-txns-table-wrap ${isDesktopPanel ? 'desktop-panel-table-wrap' : ''}`}>
        <table className="sheet-txns-table detail-txn-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Date</th>
              <th style={{ textAlign: 'right' }}>{metrics.qtyLabel || 'Units'}</th>
              <th style={{ textAlign: 'right' }}>{metrics.isMf ? 'NAV' : 'Price'}</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {sortedTxns.map((t, idx) => {
              const txnInfo = extractTxnDetails(t, metrics.isMf);
              const isBuy = txnInfo.isBuy;
              const actionLbl = txnInfo.actionLbl;

              const formattedUnitsStr = metrics.isMf
                ? txnInfo.parsedUnits.toFixed(3)
                : Math.round(txnInfo.parsedUnits);

              const priceStr = txnInfo.parsedPrice > 0 ? `₹${txnInfo.parsedPrice.toFixed(2)}` : '—';
              const tradeValStr = formatINR(txnInfo.parsedVal);

              const isPosAmount = metrics.isMf ? isBuy : !isBuy;
              const amountSign = metrics.isMf ? '+' : (isBuy ? '-' : '+');
              const pnlClass = isPosAmount ? 'pos' : 'neg';

              return (
                <tr
                  key={t.rawTxn?.ID || t.id || idx}
                  className={`sheet-txn-row ${onSelectTxn ? 'clickable' : ''}`}
                  onClick={() => onSelectTxn && onSelectTxn(t)}
                  title={t.note || t.Note || ''}
                >
                  <td>
                    <span className={`txn-action-tag ${isBuy ? 'buy' : 'sell'}`}>
                      {actionLbl}
                    </span>
                  </td>
                  <td className="num-tabular mono font-semibold">{txnInfo.date}</td>
                  <td style={{ textAlign: 'right' }} className={`mono font-bold num-tabular ${isBuy ? 'pos' : 'neg'}`}>
                    {isBuy ? '+' : '-'}{formattedUnitsStr}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono text-muted num-tabular font-semibold">
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
    );
  };

  // ── 3. ACCOUNTING & AUDIT KEY-VALUES PANEL ────────────────────────────────
  const renderAccountingContent = () => {
    return (
      <div className="sheet-grid-2 detail-accounting-grid">
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Platform / Subaccount</span>
          <span className="sec-val font-semibold text-primary">{displayPos.subAccount}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Investment Account</span>
          <span className="sec-val font-semibold text-primary">{displayPos.investmentAccount}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">ISIN</span>
          <span className="sec-val font-semibold mono text-primary">{displayPos.isin || '—'}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Folio Number</span>
          <span className="sec-val font-semibold mono text-primary">{displayPos.folioNumber || 'Single Folio'}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Holding Mode</span>
          <span className="sec-val font-semibold text-primary">{displayPos.holdingMode || 'PHYSICAL/SOA'}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Ownership Scope</span>
          <span className="sec-val font-semibold text-primary">{displayPos.ownershipTag === 'MIXED_HOLDING' ? 'Mixed Holding' : (displayPos.ownershipTag || 'Individual')}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Realized P&L</span>
          <span className="sec-val num-tabular font-bold">
            {displayPos.realizedPnl !== 0 ? (
              <span className={displayPos.realizedPnl > 0 ? 'pos' : 'neg'}>
                {displayPos.realizedPnl > 0 ? '+' : ''}{formatINR(displayPos.realizedPnl)}
              </span>
            ) : '₹0.00'}
          </span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Accounting Method</span>
          <span className="sec-val font-semibold text-primary">First-In, First-Out (FIFO)</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Total Transactions</span>
          <span className="sec-val font-semibold mono text-primary">{sortedTxns.length}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted">Active FIFO Lots</span>
          <span className="sec-val font-semibold mono text-primary">{enrichedLots.filter(l => (l.remUnits || 0) > 0).length}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="investments-portfolio-screen fund-detail-fullpage">
      {/* 1. Header Bar */}
      <div className="portfolio-top-bar">
        <button className="portfolio-back-btn" onClick={onClose} title="Back to Portfolio">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="20" height="20">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="portfolio-top-titles" style={{ minWidth: 0, flex: 1 }}>
          <h2 className="portfolio-main-title holding-card-name" title={position.note || position.security}>
            {position.note || position.security}
          </h2>
        </div>
      </div>

      <div className="portfolio-scrollable-content detail-scrollable-content">
        {/* 2. Top Summary Cards: Centered Horizontally Side-by-Side (Max ~1040px width, Gap ~22px) */}
        <div className="detail-top-cards-grid mb-3">
          {/* Card A: Financial Performance Overview (Symmetrical 2 × 2 Grid) */}
          <div className="portfolio-card detail-hero-card">
            <div className="portfolio-card-header mb-2 flex-between align-center">
              <h4 className="portfolio-card-title detail-card-heading">Performance Overview</h4>
              {isValued && activeValuation?.asOf && !isRedeemed && (
                <span className="detail-as-of-meta text-muted">
                  As of {formatAsOfDate(activeValuation.asOf)}{activeValuation?.asOfTime ? `, ${activeValuation.asOfTime}` : ''}
                </span>
              )}
            </div>

            <div className="detail-hero-grid-2x2">
              {/* Row 1, Col 1: Current Value */}
              <div className="detail-kpi-cell">
                <span className="detail-metric-lbl text-muted">Current Value</span>
                <div className={`detail-metric-val font-bold num-tabular mt-0.5 ${isRedeemed ? 'text-muted' : 'text-primary'}`}>
                  {isRedeemed ? '₹0 (Closed)' : (isValued ? formatINR(activeValuation.currentValue) : <span className="val-na text-muted">{metrics.unvaluedLabel}</span>)}
                </div>
                {dailyChange && !isRedeemed ? (
                  <div
                    className={`todays-change font-semibold num-tabular mt-0.5 ${dailyChange.cls}`}
                    style={{ fontSize: '0.74rem', color: dailyChange.color, cursor: 'pointer' }}
                    title="Tap 1D change to toggle price vs position P&L"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onToggleOneDayDisplayMode) onToggleOneDayDisplayMode(e);
                    }}
                  >
                    1D: {dailyChange.text}
                  </div>
                ) : (
                  <div className="detail-sub-placeholder" />
                )}
              </div>

              {/* Row 1, Col 2: Total P&L */}
              <div className="detail-kpi-cell">
                <span className="detail-metric-lbl text-muted">{isRedeemed ? 'Realized P&L' : 'Total P&L'}</span>
                {isRedeemed ? (
                  <div className={`detail-metric-val font-bold num-tabular mt-0.5 ${getPnlClass(displayPos.realizedPnl)}`}>
                    {formatSignedCurrency(displayPos.realizedPnl)}
                  </div>
                ) : isValued ? (
                  <div className="detail-pnl-wrap mt-0.5">
                    <span className={`detail-metric-val font-bold num-tabular ${getPnlClass(activeValuation.unrealizedPnl)}`}>
                      {formatSignedCurrency(activeValuation.unrealizedPnl)}
                    </span>
                    <span className={`detail-pnl-pill num-tabular font-bold ml-1 ${getPnlClass(activeValuation.unrealizedPnl)}`}>
                      {formatSignedPercent(activeValuation.returnPercent)}
                    </span>
                  </div>
                ) : (
                  <div className="detail-metric-val text-muted mt-0.5">—</div>
                )}
                {!isRedeemed && displayPos.realizedPnl !== 0 ? (
                  <div className="detail-metric-sub text-muted font-xs mt-0.5 num-tabular">
                    Realized: <span className={getPnlClass(displayPos.realizedPnl)}>{formatSignedCurrency(displayPos.realizedPnl)}</span>
                  </div>
                ) : (
                  <div className="detail-sub-placeholder" />
                )}
              </div>

              {/* Row 2, Col 1: Invested Cost */}
              <div className="detail-kpi-cell">
                <span className="detail-metric-lbl text-muted">{isRedeemed ? 'Cost Basis' : 'Invested Cost'}</span>
                <div className="detail-metric-val secondary font-bold num-tabular mt-0.5 text-primary">
                  {formatINR(isRedeemed ? (displayPos.buyCost || displayPos.soldCostBasis || displayPos.remainingCostBasis) : displayPos.remainingCostBasis)}
                </div>
                <div className="detail-metric-sub text-muted font-xs mt-0.5">
                  {displayLots.length} acquisition {displayLots.length === 1 ? 'lot' : 'lots'}
                </div>
              </div>

              {/* Row 2, Col 2: Portfolio XIRR */}
              <div className="detail-kpi-cell">
                <span className="detail-metric-lbl text-muted">Portfolio XIRR</span>
                <div className="detail-metric-val secondary font-bold num-tabular mt-0.5">
                  {detailXirr !== null ? (
                    <span className={getPnlClass(detailXirr)}>
                      {formatSignedPercent(detailXirr)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </div>
                <div className="detail-metric-sub text-muted font-xs mt-0.5">
                  Compounding cashflow IRR
                </div>
              </div>
            </div>
          </div>

          {/* Card B: Position Specs & Lifecycle */}
          <div className="portfolio-card detail-lifecycle-card">
            <div className="portfolio-card-header mb-2 flex-between align-center">
              <h4 className="portfolio-card-title detail-card-heading">Position Specs & Lifecycle</h4>
              <span className="detail-as-of-meta text-muted mono">{displayPos.isin || 'ID'}</span>
            </div>

            <div className="detail-lifecycle-grid-3x2">
              {/* Cell 1: First Acquired & Duration */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted">First Acquired</span>
                <span className="lifecycle-val font-semibold mono text-primary mt-0.5">
                  {firstAcquiredDate || '—'}
                </span>
                {ageInfo.fullStr && (
                  <span className="lifecycle-sub text-muted font-xs mt-0.5">
                    {ageInfo.fullStr}
                  </span>
                )}
              </div>

              {/* Cell 2: Status */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted">{isRedeemed ? 'Exit Date' : 'Status'}</span>
                <span className="lifecycle-val font-semibold mono text-primary mt-0.5">
                  {isRedeemed ? (displayPos.exitDate || displayPos.lastTransactionDate || '—') : 'Active Holding'}
                </span>
              </div>

              {/* Cell 3: Total Units */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted">{isRedeemed ? 'Qty Exited' : metrics.qtyLabel}</span>
                <span className="lifecycle-val font-semibold mono num-tabular text-primary mt-0.5">
                  {isRedeemed ? (
                    (displayPos.investmentAccount === 'Share Market' || displayPos.holdingMode === 'DEMAT')
                      ? `${Math.round(exitedUnits)} shares`
                      : `${exitedUnits.toFixed(3)} units`
                  ) : (
                    metrics.rawQty || metrics.formattedQty
                  )}
                </span>
              </div>

              {/* Cell 4: Avg NAV */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted">{isRedeemed ? 'Avg Acq NAV' : metrics.avgPriceLabel}</span>
                <span className="lifecycle-val font-semibold mono num-tabular text-primary mt-0.5">
                  {avgBuyPriceStr}
                </span>
              </div>

              {/* Cell 5: Platform */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted">Platform</span>
                <span className="lifecycle-val font-semibold text-primary mt-0.5">
                  {displayPos.subAccount || position.subAccount}
                </span>
              </div>

              {/* Cell 6: Folio / Mode */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted">Folio / Mode</span>
                <span className="lifecycle-val font-semibold mono text-primary mt-0.5">
                  {displayPos.folioNumber || position.folioNumber || displayPos.holdingMode || '—'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Folios Filter Section (if aggregated / multiple folios) */}
        {isAggregated && (
          <div className="portfolio-card detail-folios-card mb-2.5">
            <div className="portfolio-card-header flex-between mb-2">
              <h4 className="portfolio-card-title font-xs text-muted">
                Underlying Folios ({underlyingPositions.length})
              </h4>
              <span className="font-xs text-muted">Select a folio to inspect tranches</span>
            </div>

            <div className="portfolio-pill-selector folio-pills-bar mb-2.5">
              <button
                className={`portfolio-pill ${selectedFolioKey === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedFolioKey('all')}
              >
                All Folios ({formatINR(position.remainingCostBasis)})
              </button>
              {underlyingPositions.map((p, idx) => (
                <button
                  key={p.positionKey || idx}
                  className={`portfolio-pill ${selectedFolioKey === String(idx) ? 'active' : ''}`}
                  onClick={() => setSelectedFolioKey(String(idx))}
                >
                  Folio {p.folioNumber} ({p.subAccount})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 4A. DESKTOP & TABLET ADAPTIVE GRID (>=768px): All 3 Side-by-Side Information Panels
            Ordering: 1. FIFO Lots | 2. Transaction History | 3. Accounting & Audit */}
        <div className="detail-panels-adaptive-grid mb-3">
          {/* Panel 1: FIFO Lots / Acquisition Lot Analysis with Current Return (%) */}
          <div className="portfolio-card detail-panel panel-fifo">
            <div className="detail-panel-header">
              <div className="flex-between align-center">
                <h3 className="detail-panel-title">
                  FIFO Lots
                  <span className="count-badge ml-1.5">{enrichedLots.length}</span>
                </h3>
              </div>
              <p className="detail-panel-subtitle text-muted font-xs">Chronological acquisition tranches with returns</p>
            </div>
            <SmartScrollContainer className="detail-panel-body">
              {renderFifoTable(true)}
            </SmartScrollContainer>
          </div>

          {/* Panel 2: Transaction History */}
          <div className="portfolio-card detail-panel panel-txns">
            <div className="detail-panel-header">
              <div className="flex-between align-center">
                <h3 className="detail-panel-title">
                  Transaction History
                  <span className="count-badge ml-1.5">{sortedTxns.length}</span>
                </h3>
              </div>
              <p className="detail-panel-subtitle text-muted font-xs">All buy, sell, and redemption transactions</p>
            </div>
            <SmartScrollContainer className="detail-panel-body">
              {renderTxnTable(true)}
            </SmartScrollContainer>
          </div>

          {/* Panel 3: Accounting & Audit */}
          <div className="portfolio-card detail-panel panel-accounting">
            <div className="detail-panel-header">
              <h3 className="detail-panel-title">Accounting & Audit</h3>
              <p className="detail-panel-subtitle text-muted font-xs">Portfolio metadata and tax classification</p>
            </div>
            <SmartScrollContainer className="detail-panel-body">
              {renderAccountingContent()}
            </SmartScrollContainer>
          </div>
        </div>

        {/* 4B. MOBILE VIEW (<768px): Tabbed Navigation
            Consistent Order: 1. FIFO Lots | 2. Transactions | 3. Accounting */}
        <div className="detail-mobile-tab-view mb-3">
          <div className="portfolio-pill-selector detail-pill-selector mb-2.5">
            <button
              className={`portfolio-pill ${activeTab === 'fifo' ? 'active' : ''}`}
              onClick={() => setActiveTab('fifo')}
            >
              FIFO Lots ({enrichedLots.length})
            </button>
            <button
              className={`portfolio-pill ${activeTab === 'txns' ? 'active' : ''}`}
              onClick={() => setActiveTab('txns')}
            >
              Transactions ({sortedTxns.length})
            </button>
            <button
              className={`portfolio-pill ${activeTab === 'accounting' ? 'active' : ''}`}
              onClick={() => setActiveTab('accounting')}
            >
              Accounting
            </button>
          </div>

          {activeTab === 'fifo' && (
            <div className="portfolio-card detail-tab-card">
              <SmartScrollContainer className="mobile-table-scroll">
                {renderFifoTable(false)}
              </SmartScrollContainer>
            </div>
          )}

          {activeTab === 'txns' && (
            <div className="portfolio-card detail-tab-card">
              <SmartScrollContainer className="mobile-table-scroll">
                {renderTxnTable(false)}
              </SmartScrollContainer>
            </div>
          )}

          {activeTab === 'accounting' && (
            <div className="portfolio-card detail-tab-card">
              <SmartScrollContainer className="mobile-table-scroll">
                {renderAccountingContent()}
              </SmartScrollContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
