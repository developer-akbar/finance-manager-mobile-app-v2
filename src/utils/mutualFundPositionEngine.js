/**
 * Mutual Fund Position Engine — Pure Domain & Calculation Layer
 * 
 * Computes deterministic mutual fund holdings, FIFO lot consumption,
 * remaining cost basis, realized and unrealized P&L, and ownership views
 * from first-class normalized transactions without mutating any data or ledger balances.
 */

import { resolveSecurity } from './securityResolution.js';

export const EPSILON = 0.005; // Maximum unit tolerance for rounding residue

/**
 * Standardizes a folio number by removing internal spaces around slashes
 */
export function normalizeFolio(folio = '') {
  return String(folio || '')
    .trim()
    .replace(/\s*\/\s*/g, '/');
}

/**
 * Constructs the canonical 6-part identity key for a mutual fund position:
 * InvestmentAccount | SubAccount | SecurityISIN | FolioNumber | HoldingMode | OwnershipTag
 */
export function getCanonicalPositionKey({
  investmentAccount = 'Liquid Mutual Funds',
  subAccount = '',
  isin = '',
  security = '',
  folioNumber = '',
  holdingMode = 'NON_DEMAT',
  ownershipTag = 'PERSONAL'
}) {
  const normAcct = String(investmentAccount || 'Liquid Mutual Funds').trim();
  const normSub = String(subAccount || '').trim();
  const normIsin = String(isin || security || '').trim().toUpperCase();
  const normFolio = normalizeFolio(folioNumber);
  const normMode = String(holdingMode || 'NON_DEMAT').trim().toUpperCase();
  const normOwner = (ownershipTag === 'EXTERNAL' || ownershipTag === 'FATHER_EXTERNAL' || ownershipTag === 'EXTERNAL_FATHER')
    ? 'EXTERNAL'
    : (ownershipTag === 'MIXED_HOLDING' ? 'MIXED_HOLDING' : 'PERSONAL');

  return `${normAcct} | ${normSub} | ${normIsin} | ${normFolio} | ${normMode} | ${normOwner}`;
}

/**
 * Parses tags or pipe-delimited fields for attributes
 */
function extractTagValue(tagStr = '', key = '') {
  if (!tagStr) return '';
  const regex = new RegExp(`(?:^|[|,]\\s*)${key}:\\s*([^|,]+)`, 'i');
  const match = tagStr.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Parses individual transaction fields into canonical mutual fund representation
 */
export function parseMutualFundTransaction(t) {
  if (!t) return null;

  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
  const tags = String(t.Tags || t.tags || '').trim();
  const fromAcct = String(t.FromAccount || t.Account || t.account || '').trim();
  const toAcct = String(t.ToAccount || '').trim();
  const desc = String(t.Description || t.description || '').trim();
  const isinRaw = String(t.SecurityISIN || t.security_isin || extractTagValue(tags, 'ISIN') || extractTagValue(desc, 'ISIN') || '').trim().toUpperCase();

  // Fast pre-filter: Skip generic non-investment transactions immediately
  const isCandidate = 
    invType === 'BUY' || 
    invType === 'SELL' || 
    !!isinRaw || 
    tags.includes('MF|') || 
    tags.includes('CAMS') || 
    toAcct === 'Liquid Mutual Funds' || 
    fromAcct === 'Liquid Mutual Funds' || 
    toAcct === 'Mutual Funds Tax Saver' || 
    fromAcct === 'Mutual Funds Tax Saver' ||
    tags.includes('Ownership:') ||
    tags.includes('Folio:') ||
    !!t.InvestmentAccount || !!t.investment_account ||
    desc.includes('|');

  if (!isCandidate) return null;

  const type = String(t['Income/Expense'] || t.type || '').trim();
  const note = String(t.Note || t.note || '').trim();
  const cat = String(t.Category || t.category || '').trim();
  const invAcct = String(t.InvestmentAccount || t.investment_account || '').trim();
  const subAcctRaw = String(t.Brokerage || t.brokerage || t.SubAccount || t.sub_account || t.ToSubAccount || t.to_sub_account || t.FromSubAccount || t.from_sub_account || '').trim();

  // Explicitly reject Share Market trades (handled exclusively by brokerage accounting engine)
  const isShareMarket = invAcct === 'Share Market' || fromAcct === 'Share Market' || toAcct === 'Share Market' || cat === 'Share Market' || subAcctRaw === 'Zerodha';
  if (isShareMarket) return null;

  // Identify if this is a mutual fund account
  const isMfAccount = 
    invAcct === 'Liquid Mutual Funds' || invAcct === 'Mutual Funds Tax Saver' ||
    toAcct === 'Liquid Mutual Funds' || toAcct === 'Mutual Funds Tax Saver' ||
    fromAcct === 'Liquid Mutual Funds' || fromAcct === 'Mutual Funds Tax Saver' ||
    cat === 'Liquid Mutual Funds' || cat === 'Mutual Funds Tax Saver' || cat.includes('Mutual Funds') ||
    tags.includes('MF|') || tags.includes('CAMS');

  let isin = isinRaw;

  // If ISIN is missing on an investment candidate, resolve from SecuritySymbol / SecurityDisplayName
  if (!isin) {
    const secCandidate = String(t.SecuritySymbol || t.security_symbol || t.SecurityDisplayName || t.security_display_name || '').trim();
    if (secCandidate) {
      const resolved = resolveSecurity(secCandidate);
      if (resolved && resolved.isResolved && resolved.isin && resolved.isin.trim().toUpperCase().startsWith('INF')) {
        isin = resolved.isin.trim().toUpperCase();
      }
    }
  }

  // STRICT INVESTMENT GATE:
  // A mutual fund investment holding MUST have a valid mutual fund ISIN starting with 'INF'
  const isINF = isin && isin.startsWith('INF');
  if (!isINF) return null;

  // STRICT GATE: Must have explicit investment evidence (preventing generic bank transfers from becoming positions)
  const hasInvestmentEvidence = 
    invType === 'BUY' || 
    invType === 'SELL' || 
    invType === 'DIVIDEND_REINVEST' || 
    invType === 'CORPORATE_ACTION' || 
    invType === 'UNIT_ADJUSTMENT' || 
    invType === 'OPENING_LOT' ||
    tags.includes('Folio:') || 
    tags.includes('ISIN:INF') ||
    desc.includes('CAMS_CAS') || 
    desc.includes('CAS MF') ||
    (desc.includes('ISIN=INF') && desc.includes('Folio='));

  if (!hasInvestmentEvidence) return null;

  // Investment Account
  let investmentAccount = invAcct;
  if (!investmentAccount) {
    if (toAcct === 'Mutual Funds Tax Saver' || fromAcct === 'Mutual Funds Tax Saver' || cat.includes('Tax Saver')) {
      investmentAccount = 'Mutual Funds Tax Saver';
    } else {
      investmentAccount = 'Liquid Mutual Funds';
    }
  }

  // SubAccount
  let subAccount = String(t.Brokerage || t.brokerage || t.SubAccount || t.sub_account || t.ToSubAccount || t.to_sub_account || t.FromSubAccount || t.from_sub_account || '').trim();
  if (!subAccount) {
    const combined = `${note} ${desc}`.toLowerCase();
    if (combined.includes('ammi')) subAccount = 'Ammi Groww';
    else if (combined.includes('etmoney') || combined.includes('et money')) subAccount = 'Fareeda ETMoney';
    else if (combined.includes('groww')) subAccount = 'Fareeda Groww';
    else if (combined.includes('ak')) subAccount = 'Ak ETMoney';
  }

  // Folio Number
  let folioNumber = String(t.FolioNumber || t.folio_number || extractTagValue(tags, 'Folio') || '').trim();
  if (!folioNumber && desc.includes('Folio=')) {
    const m = desc.match(/Folio=([^|\r\n]+)/i);
    if (m) folioNumber = m[1].trim();
  }

  // Holding Mode
  let holdingMode = String(t.HoldingMode || t.holding_mode || extractTagValue(tags, 'Mode') || '').trim().toUpperCase();
  if (!holdingMode) {
    const combined = `${desc} ${t.SecuritySymbol || ''}`.toUpperCase();
    if (combined.includes('DEMAT') && !combined.includes('NON DEMAT') && !combined.includes('NON-DEMAT')) {
      holdingMode = 'DEMAT';
    } else {
      holdingMode = 'NON_DEMAT';
    }
  }

  // Ownership Tag — Canonical Single Source of Truth
  let rawOwn = (
    t.OwnershipTag ||
    t.ownership_tag ||
    extractTagValue(tags, 'Ownership') ||
    extractTagValue(desc, 'Ownership') ||
    ''
  ).toUpperCase().trim();

  let ownershipTag = 'PERSONAL';
  if (rawOwn === 'EXTERNAL' || rawOwn === 'FATHER_EXTERNAL' || rawOwn === 'EXTERNAL_FATHER') {
    ownershipTag = 'EXTERNAL';
  } else if (rawOwn === 'MIXED_HOLDING' || rawOwn === 'MIXED') {
    ownershipTag = 'MIXED_HOLDING';
  } else if (rawOwn === 'PERSONAL') {
    ownershipTag = 'PERSONAL';
  } else {
    ownershipTag = 'PERSONAL';
  }

  let quantity = Math.abs(parseFloat(t.Quantity !== undefined && t.Quantity !== '' ? t.Quantity : (t.quantity !== undefined && t.quantity !== '' ? t.quantity : (t.Units !== undefined && t.Units !== '' ? t.Units : (t.units !== undefined && t.units !== '' ? t.units : 0)))) || 0);
  if (!quantity && desc) {
    const m = desc.match(/([0-9.]+)\s*Units/i);
    if (m) quantity = parseFloat(m[1]) || 0;
  }

  let unitPrice = parseFloat(t.UnitPrice !== undefined && t.UnitPrice !== '' ? t.UnitPrice : (t.unit_price !== undefined && t.unit_price !== '' ? t.unit_price : (t.NAV !== undefined && t.NAV !== '' ? t.NAV : (t.nav !== undefined && t.nav !== '' ? t.nav : 0)))) || 0;
  if (!unitPrice && desc) {
    const m = desc.match(/@\s*([0-9.]+)/);
    if (m) unitPrice = parseFloat(m[1]) || 0;
  }

  const rawCostBasis = Math.abs(parseFloat(t.CostBasis !== undefined && t.CostBasis !== '' ? t.CostBasis : (t.cost_basis !== undefined && t.cost_basis !== '' ? t.cost_basis : 0)) || 0);
  const rawTradeValue = Math.abs(parseFloat(t.TradeValue !== undefined && t.TradeValue !== '' ? t.TradeValue : (t.trade_value !== undefined && t.trade_value !== '' ? t.trade_value : (t.Amount || t.amount || t.INR || t.inr || 0))) || 0);
  const calcVal = (quantity > 0 && unitPrice > 0) ? Math.round(quantity * unitPrice * 100) / 100 : 0;

  const totalCharges = parseFloat(
    t.TotalCharges ?? t.total_charges ?? (
      (parseFloat(t.BrokerageCharges ?? t.brokerage_charges ?? 0) || 0) +
      (parseFloat(t.ExchangeCharges ?? t.exchange_charges ?? 0) || 0) +
      (parseFloat(t.STTCharges ?? t.stt_charges ?? 0) || 0) +
      (parseFloat(t.SEBICharges ?? t.sebi_charges ?? 0) || 0) +
      (parseFloat(t.StampDutyCharges ?? t.stamp_duty_charges ?? 0) || 0) +
      (parseFloat(t.GSTCharges ?? t.gst_charges ?? 0) || 0) +
      (parseFloat(t.DPCharges ?? t.dp_charges ?? 0) || 0) +
      (parseFloat(t.OtherCharges ?? t.other_charges ?? 0) || 0)
    )
  ) || 0;

  // Map Action
  let action = 'BUY';
  if (invType === 'SELL') {
    action = 'SELL';
  } else if (invType === 'BUY' || invType === 'DIVIDEND_REINVEST' || invType === 'OPENING_LOT') {
    action = 'BUY';
  } else if (invType === 'UNIT_ADJUSTMENT' || invType === 'CORPORATE_ACTION') {
    action = 'UNIT_ADJUSTMENT';
  } else if (type === 'Transfer-Out' && fromAcct.includes('Mutual Funds') && (desc.includes('REDEMPTION') || desc.includes('SELL'))) {
    action = 'SELL';
  }

  let costBasis = 0;
  let tradeValue = 0;

  if (action === 'BUY') {
    costBasis = rawCostBasis > 0 ? rawCostBasis : ((rawTradeValue > 0 ? rawTradeValue : calcVal) + totalCharges);
    tradeValue = rawTradeValue > 0 ? rawTradeValue : (calcVal > 0 ? calcVal : (costBasis - totalCharges));
  } else if (action === 'SELL') {
    tradeValue = rawTradeValue > 0 ? rawTradeValue : (calcVal > 0 ? calcVal : rawCostBasis);
    costBasis = rawCostBasis;
  } else {
    // UNIT_ADJUSTMENT
    tradeValue = 0;
    costBasis = 0;
  }

  if (quantity > 0 && unitPrice === 0 && tradeValue > 0) {
    unitPrice = Math.round((tradeValue / quantity) * 10000) / 10000;
  } else if (unitPrice > 0 && quantity === 0 && tradeValue > 0) {
    quantity = Math.round((tradeValue / unitPrice) * 1000) / 1000;
  }

  const realizedPnl = parseFloat(t.RealizedPnl !== undefined && t.RealizedPnl !== '' ? t.RealizedPnl : (t.realized_pnl !== undefined && t.realized_pnl !== '' ? t.realized_pnl : 0)) || 0;

  // Security display name
  let security = t.SecuritySymbol || t.security_symbol || '';
  if (!security) {
    const res = resolveSecurity(isin);
    security = res?.displayName || res?.symbol || isin;
  }

  return {
    id: t.ID || t.id || '',
    date: t.Date || t.date || '',
    action,
    investmentAccount,
    subAccount,
    isin,
    folioNumber: normalizeFolio(folioNumber),
    holdingMode,
    ownershipTag,
    quantity,
    unitPrice,
    tradeValue,
    costBasis,
    realizedPnl,
    security,
    note,
    rawTxn: t
  };
}

/**
 * Calculates current mutual fund positions from normalized transactions.
 * 
 * @param {Array} transactions Array of FinMan transactions
 * @param {Object} options Optional configuration (navMap, asOfDate)
 * @returns {Object} { positions, positionsByKey, summary, getPersonalPortfolio }
 */
export function calculateMutualFundPositions(transactions = [], options = {}) {
  const { navMap = {}, asOfDate = null } = options;

  // Filter and sort transactions chronologically
  const parsedTxns = [];
  for (const t of transactions) {
    const p = parseMutualFundTransaction(t);
    if (p && (p.isin || p.security || p.note) && (p.action === 'BUY' || p.action === 'SELL' || p.action === 'UNIT_ADJUSTMENT')) {
      parsedTxns.push(p);
    }
  }

  // Sort by date (oldest first for FIFO lot processing)
  parsedTxns.sort((a, b) => {
    const parseD = (s) => {
      const parts = (s || '').split('/');
      if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
      return new Date(s || 0).getTime() || 0;
    };
    return parseD(a.date) - parseD(b.date);
  });

  // Group by canonical position key
  const positionGroups = new Map();

  for (const t of parsedTxns) {
    const key = getCanonicalPositionKey({
      investmentAccount: t.investmentAccount,
      subAccount: t.subAccount,
      isin: t.isin,
      security: t.security || t.note,
      folioNumber: t.folioNumber,
      holdingMode: t.holdingMode,
      ownershipTag: t.ownershipTag
    });

    if (!positionGroups.has(key)) {
      positionGroups.set(key, {
        positionKey: key,
        investmentAccount: t.investmentAccount,
        subAccount: t.subAccount,
        isin: t.isin,
        folioNumber: t.folioNumber,
        holdingMode: t.holdingMode,
        ownershipTag: t.ownershipTag,
        security: t.security,
        note: t.note,
        txns: []
      });
    }
    positionGroups.get(key).txns.push(t);
  }

  const positions = [];
  const positionsByKey = {};

  for (const [key, group] of positionGroups.entries()) {
    let buyUnits = 0;
    let sellUnits = 0;
    let buyCost = 0;
    let totalRealizedPnl = 0;
    let sellCostBasis = 0;

    const buyLots = [];
    const sellRecords = [];
    let firstBuyDate = null;
    let lastTransactionDate = null;

    let buyCount = 0;
    let sellCount = 0;

    for (const t of group.txns) {
      lastTransactionDate = t.date;

      if (t.action === 'BUY') {
        buyCount++;
        if (!firstBuyDate) firstBuyDate = t.date;

        buyUnits += t.quantity;
        buyCost += t.costBasis;

        buyLots.push({
          transactionId: t.id,
          date: t.date,
          units: t.quantity,
          remainingUnits: t.quantity,
          unitCost: t.quantity > 0 ? t.costBasis / t.quantity : t.unitPrice,
          costBasis: t.costBasis,
          ownershipTag: t.ownershipTag
        });
      } else if (t.action === 'SELL') {
        sellCount++;
        sellUnits += t.quantity;

        // FIFO Lot Consumption
        let unconsumedUnits = t.quantity;
        let consumedCostForThisSell = 0;

        for (const lot of buyLots) {
          if (lot.remainingUnits <= 0) continue;

          const consumeUnits = Math.min(unconsumedUnits, lot.remainingUnits);
          const consumeCost = (consumeUnits / lot.units) * lot.costBasis;

          lot.remainingUnits -= consumeUnits;
          consumedCostForThisSell += consumeCost;
          unconsumedUnits -= consumeUnits;

          if (unconsumedUnits <= 0.000001) break;
        }

        sellCostBasis += consumedCostForThisSell;

        // Calculate Realized P&L
        let pnl = 0;
        if (t.realizedPnl !== 0) {
          pnl = t.realizedPnl;
        } else if (consumedCostForThisSell > 0) {
          pnl = t.tradeValue - consumedCostForThisSell;
        } else {
          // If no cost basis can be established and no explicit realizedPnl is provided,
          // do NOT assume 100% of proceeds is profit.
          pnl = 0;
        }
        totalRealizedPnl += pnl;

        sellRecords.push({
          transactionId: t.id,
          date: t.date,
          units: t.quantity,
          tradeValue: t.tradeValue,
          consumedCostBasis: consumedCostForThisSell,
          realizedPnl: pnl
        });
      } else if (t.action === 'UNIT_ADJUSTMENT') {
        // Corporate / Segregated portfolio unit adjustment: does not consume FIFO cost lots or generate P&L
      }
    }

    const currentUnitsRaw = buyUnits - sellUnits;
    const remainingCostBasisRaw = buyLots.reduce((acc, lot) => acc + (lot.remainingUnits * lot.unitCost), 0);

    // Precision and Status Classification
    let status = 'ACTIVE';
    let isResidual = false;
    let currentUnits = roundUnits(currentUnitsRaw);
    let remainingCostBasis = roundMoney(remainingCostBasisRaw);

    if (currentUnitsRaw < -EPSILON) {
      // If all original cash buy lots were completely consumed (remainingCostBasisRaw <= EPSILON)
      // and subsequent redemptions/extinguishments were zero-cost side-pocket payouts,
      // the investment is fully closed/liquidated (current units = 0, status = REDEEMED).
      if (remainingCostBasisRaw <= EPSILON && buyLots.every(l => l.remainingUnits <= EPSILON)) {
        status = 'REDEEMED';
        currentUnits = 0;
        remainingCostBasis = 0;
      } else {
        status = 'LEGACY_DATA_ISSUE';
      }
    } else if (Math.abs(currentUnitsRaw) <= EPSILON) {
      status = 'REDEEMED';
      if (Math.abs(currentUnitsRaw) > 0.00001) {
        isResidual = true;
      }
      currentUnits = 0;
      remainingCostBasis = 0;
    } else {
      status = 'ACTIVE';
    }

    const averageCostPerUnit = currentUnits > 0 ? roundMoney(remainingCostBasis / currentUnits, 4) : 0;

    // Current NAV & Valuation Abstraction
    const currentNav = navMap[group.isin] !== undefined 
      ? navMap[group.isin] 
      : (navMap[key] !== undefined ? navMap[key] : null);

    const currentValue = (currentNav !== null && currentNav !== undefined)
      ? roundMoney(currentUnits * currentNav)
      : null;

    const unrealizedPnl = (currentValue !== null && status === 'ACTIVE')
      ? roundMoney(currentValue - remainingCostBasis)
      : null;

    const positionObj = {
      positionKey: key,
      investmentAccount: group.investmentAccount,
      subAccount: group.subAccount,
      security: group.security,
      note: group.note,
      isin: group.isin,
      folioNumber: group.folioNumber,
      holdingMode: group.holdingMode,
      ownershipTag: group.ownershipTag,

      buyUnits: roundUnits(buyUnits),
      sellUnits: roundUnits(sellUnits),
      currentUnits,

      buyCost: roundMoney(buyCost),
      sellCostBasis: roundMoney(sellCostBasis),
      remainingCostBasis,

      averageCostPerUnit,
      realizedPnl: roundMoney(totalRealizedPnl),

      currentNav,
      currentValue,
      unrealizedPnl,

      transactionCount: group.txns.length,
      buyCount,
      sellCount,

      firstBuyDate,
      lastTransactionDate,

      status,
      isResidual,
      buyLots,
      txns: group.txns
    };

    positions.push(positionObj);
    positionsByKey[key] = positionObj;
  }

  // Summary Aggregation
  const summary = {
    totalPositions: positions.length,
    totalActivePositions: positions.filter(p => p.status === 'ACTIVE').length,
    totalRedeemedPositions: positions.filter(p => p.status === 'REDEEMED').length,
    totalLegacyIssuePositions: positions.filter(p => p.status === 'LEGACY_DATA_ISSUE').length,

    activeUnits: roundUnits(positions.filter(p => p.status === 'ACTIVE').reduce((acc, p) => acc + p.currentUnits, 0)),
    activeCostBasis: roundMoney(positions.filter(p => p.status === 'ACTIVE').reduce((acc, p) => acc + p.remainingCostBasis, 0)),
    totalRealizedPnl: roundMoney(positions.reduce((acc, p) => acc + p.realizedPnl, 0)),

    byOwnership: {
      PERSONAL: aggregatePositions(positions.filter(p => p.ownershipTag === 'PERSONAL')),
      EXTERNAL: aggregatePositions(positions.filter(p => p.ownershipTag === 'EXTERNAL' || p.ownershipTag === 'FATHER_EXTERNAL')),
      FATHER_EXTERNAL: aggregatePositions(positions.filter(p => p.ownershipTag === 'EXTERNAL' || p.ownershipTag === 'FATHER_EXTERNAL')),
      MIXED_HOLDING: aggregatePositions(positions.filter(p => p.ownershipTag === 'MIXED_HOLDING'))
    },

    bySubAccount: {}
  };

  const uniqueSubs = new Set(positions.map(p => p.subAccount).filter(Boolean));
  for (const sub of uniqueSubs) {
    summary.bySubAccount[sub] = aggregatePositions(positions.filter(p => p.subAccount === sub));
  }

  // Helper to filter Personal Portfolio (Excludes EXTERNAL and legacy FATHER_EXTERNAL)
  const getPersonalPortfolio = () => {
    return positions.filter(p => p.ownershipTag === 'PERSONAL' || p.ownershipTag === 'MIXED_HOLDING');
  };

  return {
    positions,
    positionsByKey,
    summary,
    getPersonalPortfolio
  };
}

function aggregatePositions(posList = []) {
  const active = posList.filter(p => p.status === 'ACTIVE');
  return {
    totalPositions: posList.length,
    activePositions: active.length,
    currentUnits: roundUnits(active.reduce((acc, p) => acc + p.currentUnits, 0)),
    costBasis: roundMoney(active.reduce((acc, p) => acc + p.remainingCostBasis, 0)),
    realizedPnl: roundMoney(posList.reduce((acc, p) => acc + p.realizedPnl, 0))
  };
}

function roundUnits(val, dec = 3) {
  const factor = Math.pow(10, dec);
  return Math.round(val * factor) / factor;
}

function roundMoney(val, dec = 2) {
  const factor = Math.pow(10, dec);
  return Math.round(val * factor) / factor;
}
