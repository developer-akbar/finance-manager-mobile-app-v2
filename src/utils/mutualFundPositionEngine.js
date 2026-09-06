/**
 * Mutual Fund Position Engine — Pure Domain & Calculation Layer
 * 
 * Computes deterministic mutual fund holdings, FIFO lot consumption,
 * remaining cost basis, realized and unrealized P&L, and ownership views
 * from first-class normalized transactions without mutating any data or ledger balances.
 */

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
 * Constructs the canonical 5-part identity key for a mutual fund position:
 * InvestmentAccount | SubAccount | SecurityISIN | FolioNumber | HoldingMode
 */
export function getCanonicalPositionKey({
  investmentAccount = 'Liquid Mutual Funds',
  subAccount = '',
  isin = '',
  folioNumber = '',
  holdingMode = 'NON_DEMAT'
}) {
  const normAcct = String(investmentAccount || 'Liquid Mutual Funds').trim();
  const normSub = String(subAccount || '').trim();
  const normIsin = String(isin || '').trim().toUpperCase();
  const normFolio = normalizeFolio(folioNumber);
  const normMode = String(holdingMode || 'NON_DEMAT').trim().toUpperCase();

  return `${normAcct} | ${normSub} | ${normIsin} | ${normFolio} | ${normMode}`;
}

/**
 * Parses tags or pipe-delimited fields for attributes
 */
function extractTagValue(tagStr = '', key = '') {
  if (!tagStr) return '';
  const regex = new RegExp(`(?:^|[|,]\\s*)${key}:([^|,]+)`, 'i');
  const match = tagStr.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Parses individual transaction fields into canonical mutual fund representation
 */
export function parseMutualFundTransaction(t) {
  if (!t) return null;

  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
  const type = String(t['Income/Expense'] || t.type || '').trim();
  const note = String(t.Note || t.note || '').trim();
  const desc = String(t.Description || t.description || '').trim();
  const tags = String(t.Tags || t.tags || '').trim();
  const fromAcct = String(t.FromAccount || t.Account || t.account || '').trim();
  const toAcct = String(t.ToAccount || '').trim();
  const isin = String(t.SecurityISIN || t.security_isin || extractTagValue(tags, 'ISIN') || '').trim().toUpperCase();

  // Identify if this is a mutual fund transaction
  const isMF = 
    invType === 'BUY' || 
    invType === 'SELL' || 
    !!isin || 
    tags.includes('MF|') || 
    tags.includes('CAMS') || 
    toAcct === 'Liquid Mutual Funds' || 
    fromAcct === 'Liquid Mutual Funds' || 
    toAcct === 'Mutual Funds Tax Saver' || 
    fromAcct === 'Mutual Funds Tax Saver';

  if (!isMF) return null;

  // Investment Account
  let investmentAccount = String(t.InvestmentAccount || t.investment_account || '').trim();
  if (!investmentAccount) {
    if (toAcct === 'Liquid Mutual Funds' || toAcct === 'Mutual Funds Tax Saver') {
      investmentAccount = toAcct;
    } else if (fromAcct === 'Liquid Mutual Funds' || fromAcct === 'Mutual Funds Tax Saver') {
      investmentAccount = fromAcct;
    } else if (String(t.Category || '').includes('Tax Saver')) {
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

  // Ownership Tag
  let ownershipTag = extractTagValue(tags, 'Ownership').toUpperCase();
  if (!ownershipTag) {
    const combined = `${note} ${desc}`.toLowerCase();
    if (combined.includes('father')) {
      ownershipTag = 'FATHER_EXTERNAL';
    } else if (combined.includes('mixed') || (subAccount === 'Fareeda ETMoney' && (folioNumber.includes('8470103') || folioNumber.includes('91055029576')) && !combined.includes('father'))) {
      ownershipTag = 'MIXED_HOLDING';
    } else {
      ownershipTag = 'PERSONAL';
    }
  }

  const quantity = Math.abs(parseFloat(t.Quantity || t.quantity || 0) || 0);
  const unitPrice = parseFloat(t.UnitPrice || t.unit_price || 0) || 0;
  const tradeValue = Math.abs(parseFloat(t.TradeValue !== undefined && t.TradeValue !== '' ? t.TradeValue : (t.trade_value !== undefined && t.trade_value !== '' ? t.trade_value : (t.Amount || t.amount || 0))) || 0);
  const costBasis = Math.abs(parseFloat(t.CostBasis !== undefined && t.CostBasis !== '' ? t.CostBasis : (t.cost_basis !== undefined && t.cost_basis !== '' ? t.cost_basis : tradeValue)) || 0);
  const realizedPnl = parseFloat(t.RealizedPnl !== undefined && t.RealizedPnl !== '' ? t.RealizedPnl : (t.realized_pnl !== undefined && t.realized_pnl !== '' ? t.realized_pnl : 0)) || 0;

  return {
    id: t.ID || t.id || '',
    date: t.Date || t.date || '',
    action: invType === 'SELL' ? 'SELL' : (invType === 'BUY' ? 'BUY' : (type === 'Transfer-Out' && fromAcct.includes('Mutual Funds') ? 'SELL' : 'BUY')),
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
    security: t.SecuritySymbol || t.security_symbol || note,
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
    if (p && p.isin && (p.action === 'BUY' || p.action === 'SELL')) {
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
      folioNumber: t.folioNumber,
      holdingMode: t.holdingMode
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
        } else {
          pnl = t.tradeValue - consumedCostForThisSell;
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
      status = 'LEGACY_DATA_ISSUE';
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
      FATHER_EXTERNAL: aggregatePositions(positions.filter(p => p.ownershipTag === 'FATHER_EXTERNAL')),
      MIXED_HOLDING: aggregatePositions(positions.filter(p => p.ownershipTag === 'MIXED_HOLDING'))
    },

    bySubAccount: {}
  };

  const uniqueSubs = new Set(positions.map(p => p.subAccount).filter(Boolean));
  for (const sub of uniqueSubs) {
    summary.bySubAccount[sub] = aggregatePositions(positions.filter(p => p.subAccount === sub));
  }

  // Helper to filter Personal Portfolio (Excludes FATHER_EXTERNAL)
  const getPersonalPortfolio = () => {
    return positions.filter(p => p.ownershipTag !== 'FATHER_EXTERNAL');
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
