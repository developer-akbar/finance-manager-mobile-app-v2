/**
 * Portfolio Display Aggregation Utility
 * Aggregates folio-level mutual fund positions belonging to the same scheme identity into
 * a single scheme-level presentation object for UI rendering.
 * 
 * IMPORTANT: PRESENTATION / UI CONCERN ONLY.
 * Does not alter underlying transaction ledgers, FIFO accounting, cost basis, or P&L engines.
 */

export function aggregatePositionsForDisplay(positions = [], valuationProvider = null) {
  if (!Array.isArray(positions)) return [];

  const activePositions = positions.filter(p => p.status === 'ACTIVE');
  const groupsMap = new Map();

  for (const pos of activePositions) {
    const isinKey = String(pos.isin || pos.security || '').trim().toUpperCase();
    const ownership = pos.ownershipTag || 'PERSONAL';
    const subAccount = pos.subAccount || '';
    const investmentAccount = pos.investmentAccount || '';

    // Grouping Key: ISIN (or security if missing) + ownershipTag + subAccount + investmentAccount
    const groupKey = `${ownership} | ${subAccount} | ${investmentAccount} | ${isinKey}`;

    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        groupKey,
        security: pos.security,
        note: pos.note || pos.security,
        isin: pos.isin,
        subAccount: pos.subAccount,
        investmentAccount: pos.investmentAccount,
        ownershipTag: pos.ownershipTag,
        underlyingPositions: []
      });
    }

    groupsMap.get(groupKey).underlyingPositions.push(pos);
  }

  const resultGroups = [];

  for (const [groupKey, group] of groupsMap.entries()) {
    const { underlyingPositions } = group;

    const totalUnits = underlyingPositions.reduce((sum, p) => sum + (p.currentUnits || 0), 0);
    const totalCostBasis = underlyingPositions.reduce((sum, p) => sum + (p.remainingCostBasis || 0), 0);
    const totalBuyCost = underlyingPositions.reduce((sum, p) => sum + (p.buyCost || 0), 0);
    const totalRealizedPnl = underlyingPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
    const totalBuyCount = underlyingPositions.reduce((sum, p) => sum + (p.buyCount || 0), 0);
    const totalSellCount = underlyingPositions.reduce((sum, p) => sum + (p.sellCount || 0), 0);

    const avgCostPerUnit = totalUnits > 0 ? totalCostBasis / totalUnits : 0;

    // Valuation aggregation across underlying positions
    let groupValuation = {
      nav: null,
      currentValue: null,
      unrealizedPnl: null,
      returnPercent: null,
      isValued: false,
      asOf: null,
      fetchedAt: null,
      freshness: 'UNAVAILABLE',
      displayLabel: 'Unavailable',
      source: null,
      navConflict: false,
      error: 'Missing valuation provider'
    };

    if (valuationProvider) {
      let isFullyValued = true;
      let hasAnyValuation = false;
      let sumCurrentValue = 0;
      let commonNav = null;
      let navConflict = false;
      let sampleVal = null;

      for (const pos of underlyingPositions) {
        const v = valuationProvider.getValuation(pos);
        if (v && v.isValued && typeof v.currentValue === 'number') {
          hasAnyValuation = true;
          sumCurrentValue += v.currentValue;
          if (!sampleVal) sampleVal = v;

          if (typeof v.nav === 'number') {
            if (commonNav === null) {
              commonNav = v.nav;
            } else if (Math.abs(commonNav - v.nav) > 0.0001) {
              navConflict = true;
            }
          }
        } else {
          isFullyValued = false;
        }
      }

      if (isFullyValued && hasAnyValuation && sampleVal) {
        const currentValue = Math.round(sumCurrentValue * 100) / 100;
        const unrealizedPnl = Math.round((currentValue - totalCostBasis) * 100) / 100;
        const returnPercent = totalCostBasis > 0 ? Math.round((unrealizedPnl / totalCostBasis) * 10000) / 100 : 0;

        groupValuation = {
          nav: navConflict ? null : commonNav,
          currentValue,
          unrealizedPnl,
          returnPercent,
          isValued: true,
          priceType: sampleVal.priceType,
          asOf: sampleVal.asOf,
          asOfTime: sampleVal.asOfTime || null,
          fetchedAt: sampleVal.fetchedAt,
          freshness: sampleVal.freshness,
          displayLabel: navConflict ? 'NAV Conflict' : sampleVal.displayLabel,
          source: sampleVal.source,
          navConflict,
          error: null
        };
      } else if (sampleVal) {
        groupValuation = { ...sampleVal, navConflict };
      }
    }

    const folioNumbers = Array.from(new Set(underlyingPositions.map(p => p.folioNumber).filter(Boolean)));
    const holdingModes = Array.from(new Set(underlyingPositions.map(p => p.holdingMode).filter(Boolean)));

    // Combined buy lots & transactions for acquisition inspection
    const combinedBuyLots = underlyingPositions.flatMap(p => p.buyLots || []);
    const combinedTxns = underlyingPositions.flatMap(p => p.txns || []);

    resultGroups.push({
      positionKey: groupKey,
      groupKey,
      isAggregateGroup: underlyingPositions.length > 1,
      folioCount: underlyingPositions.length,
      security: group.security,
      note: group.note,
      isin: group.isin,
      subAccount: group.subAccount,
      investmentAccount: group.investmentAccount,
      ownershipTag: group.ownershipTag,
      currentUnits: Math.round(totalUnits * 1000) / 1000,
      remainingCostBasis: Math.round(totalCostBasis * 100) / 100,
      averageCostPerUnit: Math.round(avgCostPerUnit * 10000) / 10000,
      buyCost: Math.round(totalBuyCost * 100) / 100,
      realizedPnl: Math.round(totalRealizedPnl * 100) / 100,
      buyCount: totalBuyCount,
      sellCount: totalSellCount,
      status: 'ACTIVE',
      folioNumber: underlyingPositions.length > 1 ? `${underlyingPositions.length} Folios` : (folioNumbers[0] || '1 Folio'),
      holdingMode: holdingModes.join(' & '),
      folioSummaryText: underlyingPositions.length > 1 ? `${underlyingPositions.length} folios` : (folioNumbers[0] || '1 folio'),
      holdingModeText: holdingModes.join(', '),
      underlyingPositions,
      buyLots: combinedBuyLots,
      txns: combinedTxns,
      valuation: groupValuation
    });
  }

  return resultGroups;
}

export function formatAsOfDate(dateStr) {
  if (!dateStr) return '';
  const str = String(dateStr).trim();
  
  // Handle space separator for date vs time (e.g., "2026-09-04 10:24 AM")
  const spaceIdx = str.indexOf(' ');
  let datePart = str;
  let timePart = '';
  if (spaceIdx > 0) {
    datePart = str.slice(0, spaceIdx);
    timePart = str.slice(spaceIdx).trim();
  }

  // DD-MM-YYYY or YYYY-MM-DD
  const parts = datePart.split('-');
  if (parts.length === 3) {
    let day, monthIdx, year;
    if (parts[0].length === 4) {
      // YYYY-MM-DD
      year = parts[0];
      monthIdx = parseInt(parts[1], 10) - 1;
      day = parts[2];
    } else {
      // DD-MM-YYYY
      day = parts[0];
      monthIdx = parseInt(parts[1], 10) - 1;
      year = parts[2];
    }
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (monthIdx >= 0 && monthIdx < 12 && day && year) {
      const dNum = parseInt(day, 10);
      const dFormatted = dNum < 10 ? `0${dNum}` : `${dNum}`;
      const formattedDate = `${dFormatted} ${monthNames[monthIdx]} ${year}`;
      return timePart ? `${formattedDate} ${timePart}` : formattedDate;
    }
  }

  return str;
}

export function formatSignedCurrency(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const val = Math.round(value * 100) / 100;
  if (val === 0) return '₹0';
  const absFormatted = Math.abs(val).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  return val > 0 ? `+₹${absFormatted}` : `-₹${absFormatted}`;
}

export function getPnlClass(val) {
  if (val === null || val === undefined || isNaN(val)) return '';
  const rounded = Math.round(val * 100) / 100;
  if (rounded > 0) return 'pos';
  if (rounded < 0) return 'neg';
  return '';
}

export function formatSignedPercent(percent) {
  if (percent === null || percent === undefined || isNaN(percent)) return '—';
  const pct = Math.round(percent * 100) / 100;
  if (pct === 0) return '0.00%';
  const absFormatted = Math.abs(pct).toFixed(2);
  return pct > 0 ? `+${absFormatted}%` : `-${absFormatted}%`;
}

export function parseDateToTimestamp(dateStr) {
  if (!dateStr) return NaN;
  if (dateStr instanceof Date) return dateStr.getTime();
  const str = String(dateStr).trim();
  const parts = str.split(/[/|-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)).getTime();
    } else if (parts[2].length === 4) {
      return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10)).getTime();
    }
  }
  return new Date(str).getTime();
}

/**
 * Newton-Raphson XIRR calculation algorithm for investment cash flows
 */
export function calculateXIRR(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2) return null;
  
  const validFlows = [];
  for (const cf of cashFlows) {
    if (!cf || !cf.date || typeof cf.amount !== 'number' || isNaN(cf.amount) || cf.amount === 0) continue;
    const t = parseDateToTimestamp(cf.date);
    if (!isNaN(t)) {
      validFlows.push({ amount: cf.amount, time: t });
    }
  }
  if (validFlows.length < 2) return null;

  validFlows.sort((a, b) => a.time - b.time);
  const d0 = validFlows[0].time;

  let hasNegative = false;
  let hasPositive = false;
  const flows = [];

  for (const cf of validFlows) {
    if (cf.amount < 0) hasNegative = true;
    if (cf.amount > 0) hasPositive = true;
    flows.push({
      amount: cf.amount,
      years: (cf.time - d0) / (1000 * 3600 * 24 * 365.25)
    });
  }

  if (!hasNegative || !hasPositive) return null;

  let r = 0.1; // Initial guess: 10%
  for (let iter = 0; iter < 100; iter++) {
    let f = 0;
    let df = 0;
    for (const cf of flows) {
      if (cf.years === 0) {
        f += cf.amount;
      } else {
        const denom = Math.pow(1 + r, cf.years);
        if (denom === 0 || isNaN(denom)) return null;
        f += cf.amount / denom;
        df -= (cf.years * cf.amount) / (denom * (1 + r));
      }
    }
    if (Math.abs(f) < 1e-5) {
      const xirrPct = r * 100;
      return isNaN(xirrPct) ? null : xirrPct;
    }
    if (Math.abs(df) < 1e-12) break;
    const nextR = r - f / df;
    if (isNaN(nextR) || nextR <= -0.99 || nextR > 50) break;
    r = nextR;
  }

  return null;
}

/**
 * Computes dated cash flow XIRR for a single position or aggregate group.
 */
export function computePositionXIRR(position, valuation = null) {
  if (!position) return null;
  const isRedeemed = position.status === 'REDEEMED' || position.currentUnits === 0;

  const val = valuation || position.valuation;
  const currentValue = isRedeemed ? 0 : (val && val.isValued && val.currentValue > 0 ? val.currentValue : 0);

  const txns = (position.txns && position.txns.length > 0) 
    ? position.txns 
    : (position.buyLots && position.buyLots.length > 0 ? position.buyLots : []);
  if (!Array.isArray(txns) || txns.length === 0) return null;

  const cashFlows = [];
  for (const t of txns) {
    const d = t.date || t.Date || t.firstBuyDate;
    if (!d) continue;

    const rawAction = String(t.action || t.InvestmentTransactionType || t.type || '').toUpperCase();
    const isBuy = rawAction.includes('BUY') || rawAction.includes('INVEST') || rawAction === 'OPENING_LOT' || (t.units > 0 && !rawAction.includes('SELL'));

    let amount = 0;
    const valCandidates = [t.tradeValue, t.TradeValue, t.costBasis, t.CostBasis, t.cashImpact, t.INR, t.inr, t.Amount, t.amount];
    for (const cand of valCandidates) {
      if (cand !== undefined && cand !== null && cand !== '') {
        const p = Math.abs(parseFloat(cand));
        if (!isNaN(p) && p > 0) {
          amount = p;
          break;
        }
      }
    }
    if (amount === 0 && t.units && t.unitCost) {
      amount = Math.abs(t.units * t.unitCost);
    }

    if (amount > 0) {
      if (isBuy) {
        cashFlows.push({ date: d, amount: -amount });
      } else {
        cashFlows.push({ date: d, amount: +amount });
      }
    }
  }

  if (!isRedeemed && currentValue > 0) {
    const asOfDate = (val && val.asOf) ? val.asOf : '2026-09-06';
    cashFlows.push({ date: asOfDate, amount: currentValue });
  }

  return calculateXIRR(cashFlows);
}

/**
 * Computes portfolio-level dated cash flow XIRR across active holdings.
 */
export function computePortfolioXIRR(activePositions = [], valuationProvider = null) {
  if (!Array.isArray(activePositions) || activePositions.length === 0) {
    return null;
  }

  const cashFlows = [];
  let totalTerminalValue = 0;
  let hasAnyValuation = false;
  let latestAsOf = '2026-09-06';

  for (const p of activePositions) {
    const val = valuationProvider ? valuationProvider.getValuation(p) : p.valuation;
    if (val && val.isValued && val.currentValue > 0) {
      hasAnyValuation = true;
      totalTerminalValue += val.currentValue;
      if (val.asOf) latestAsOf = val.asOf;

      const txns = (p.txns && p.txns.length > 0) ? p.txns : (p.buyLots || []);
      for (const t of txns) {
        const d = t.date || t.Date || t.firstBuyDate;
        if (!d) continue;

        const rawAction = String(t.action || t.InvestmentTransactionType || t.type || '').toUpperCase();
        const isBuy = rawAction.includes('BUY') || rawAction.includes('INVEST') || rawAction === 'OPENING_LOT' || (t.units > 0 && !rawAction.includes('SELL'));

        let amount = 0;
        const valCandidates = [t.tradeValue, t.TradeValue, t.costBasis, t.CostBasis, t.cashImpact, t.INR, t.inr, t.Amount, t.amount];
        for (const cand of valCandidates) {
          if (cand !== undefined && cand !== null && cand !== '') {
            const p = Math.abs(parseFloat(cand));
            if (!isNaN(p) && p > 0) {
              amount = p;
              break;
            }
          }
        }
        if (amount === 0 && t.units && t.unitCost) {
          amount = Math.abs(t.units * t.unitCost);
        }

        if (amount > 0) {
          if (isBuy) {
            cashFlows.push({ date: d, amount: -amount });
          } else {
            cashFlows.push({ date: d, amount: +amount });
          }
        }
      }
    }
  }

  if (!hasAnyValuation || cashFlows.length === 0 || totalTerminalValue <= 0) {
    return null;
  }

  cashFlows.push({ date: latestAsOf, amount: totalTerminalValue });
  return calculateXIRR(cashFlows);
}

export function calculateInvestmentAge(earliestDateStr, referenceDate = new Date('2026-09-06')) {
  if (!earliestDateStr) return { fullStr: '', compactStr: '', years: 0, months: 0 };
  
  let dateObj;
  const str = String(earliestDateStr).trim();
  const parts = str.split('/');
  if (parts.length === 3) {
    dateObj = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
  } else {
    const dashParts = str.split('-');
    if (dashParts.length === 3) {
      if (dashParts[0].length === 4) {
        dateObj = new Date(parseInt(dashParts[0], 10), parseInt(dashParts[1], 10) - 1, parseInt(dashParts[2], 10));
      } else {
        dateObj = new Date(parseInt(dashParts[2], 10), parseInt(dashParts[1], 10) - 1, parseInt(dashParts[0], 10));
      }
    } else {
      dateObj = new Date(str);
    }
  }

  if (isNaN(dateObj.getTime())) return { fullStr: '', compactStr: '', years: 0, months: 0 };

  const refTime = referenceDate.getTime();
  const startTime = dateObj.getTime();
  if (startTime > refTime) return { fullStr: '', compactStr: '', years: 0, months: 0 };

  let years = referenceDate.getFullYear() - dateObj.getFullYear();
  let months = referenceDate.getMonth() - dateObj.getMonth();

  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (referenceDate.getDate() < dateObj.getDate()) {
    months -= 1;
    if (months < 0) {
      years -= 1;
      months += 12;
    }
  }

  const partsArr = [];
  if (years > 0) {
    partsArr.push(`${years} ${years === 1 ? 'year' : 'years'}`);
  }
  if (months > 0 || years === 0) {
    partsArr.push(`${months} ${months === 1 ? 'month' : 'months'}`);
  }

  const fullStr = `Invested for ${partsArr.join(' ')}`;
  const compactParts = [];
  if (years > 0) compactParts.push(`${years}y`);
  if (months > 0 || years === 0) compactParts.push(`${months}m`);
  const compactStr = compactParts.join(' ');

  return { fullStr, compactStr, years, months };
}

export function getInvestmentDisplayMetrics(position, valuation = null) {
  if (!position) {
    return {
      assetType: 'MUTUAL_FUND',
      isMf: true,
      valueLabel: 'CURRENT VALUE',
      costLabel: 'Invested',
      returnLabel: 'Total returns',
      priceLabel: 'Current NAV',
      qtyLabel: 'Total Units',
      avgPriceLabel: 'Avg NAV',
      unvaluedLabel: 'NAV unavailable',
      formattedQty: '0 units',
      formattedAvgPrice: 'Avg NAV ₹0.00',
      priceTypeLabel: 'Current NAV'
    };
  }

  const nameUpper = String(position.note || position.security || '').toUpperCase();
  const isinUpper = String(position.isin || '').toUpperCase();
  const acctLower = String(position.investmentAccount || '').toLowerCase();
  const modeLower = String(position.holdingMode || '').toLowerCase();

  let assetType = 'MUTUAL_FUND';
  if (nameUpper.includes('ETF') || nameUpper.includes('BEES') || nameUpper.includes('GOLD') || nameUpper.includes('SILVER')) {
    assetType = 'ETF';
  } else if (isinUpper.startsWith('INF') || acctLower.includes('mutual fund')) {
    assetType = 'MUTUAL_FUND';
  } else if (acctLower === 'share market' || modeLower === 'demat' || position.assetType === 'EQUITY') {
    assetType = 'EQUITY';
  }

  const isMf = assetType === 'MUTUAL_FUND';

  const units = position.currentUnits || 0;
  const avgCost = position.averageCostPerUnit !== undefined && position.averageCostPerUnit !== null
    ? position.averageCostPerUnit 
    : (units > 0 ? position.remainingCostBasis / units : 0);

  // Price label determination based on ValuationResult.priceType
  const valObj = valuation || position.valuation;
  let priceTypeLabel = isMf ? 'Current NAV' : 'LTP';
  if (valObj && valObj.priceType) {
    if (valObj.priceType === 'PREVIOUS_CLOSE') {
      priceTypeLabel = 'Prev. Close';
    } else if (valObj.priceType === 'LTP') {
      priceTypeLabel = 'LTP';
    } else if (valObj.priceType === 'NAV') {
      priceTypeLabel = 'Current NAV';
    }
  }

  return {
    assetType,
    isMf,
    valueLabel: 'CURRENT VALUE',
    costLabel: 'Invested',
    returnLabel: isMf ? 'Total returns' : 'P&L',
    priceLabel: priceTypeLabel,
    priceTypeLabel,
    qtyLabel: isMf ? 'Total Units' : 'Qty',
    avgPriceLabel: isMf ? 'Avg NAV' : 'Avg Price',
    formattedQty: isMf 
      ? `${units.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} units`
      : `Qty ${Math.round(units)}`,
    rawQty: isMf
      ? units.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
      : `${Math.round(units)}`,
    formattedAvgPrice: isMf
      ? `Avg NAV ₹${avgCost.toFixed(2)}`
      : `Avg Price ₹${avgCost.toFixed(2)}`,
    unvaluedLabel: isMf ? 'NAV unavailable' : 'LTP unavailable'
  };
}


