/**
 * casAdapter.js — Generates FinMan Investment Transactions from parsed CAS data
 *
 * Implements deterministic ID hashing, multi-folio isolation, FIFO lot tracking,
 * zero cash-impact enforcement (to protect bank flows), closing unit reconciliation,
 * intelligent multi-account scheme routing, multi-platform resolution, and safe economic deduplication.
 */

import { hashString } from './brokerageAdapters.js';
import { resolveSecurity } from './securityResolution.js';

/**
 * Resolves the destination investment account based on scheme classification
 */
export function resolveSchemeAccount(schemeName = '', isin = '', defaultAccount = 'Liquid Mutual Funds') {
  const s = (schemeName || '').toLowerCase();
  if (
    s.includes('elss') ||
    s.includes('tax saver') ||
    s.includes('tax advantage') ||
    s.includes('tax-saver') ||
    s.includes('long term advantage')
  ) {
    return 'Mutual Funds Tax Saver';
  }
  return defaultAccount || 'Liquid Mutual Funds';
}

/**
 * Resolves the FinMan platform/subaccount for a scheme based on folio history,
 * advisor codes, investor profiles, or user confirmation for ambiguous folios.
 */
export function resolveFolioPlatform({
  scheme = {},
  investor = {},
  dbTransactions = [],
  existingSubAccounts = [],
  overridePlatform = null,
  manualAssignments = {}
}) {
  const schemeFolio = (scheme.folio || '').trim();
  const schemeIsin = (scheme.isin || '').trim();
  const schemeAdvisor = (scheme.advisor || '').toUpperCase();
  const investorName = (investor.name || '').toUpperCase();
  const investorEmail = (investor.email || '').toLowerCase();

  // 1. Manual user override for this specific folio or scheme
  if (schemeFolio && manualAssignments[schemeFolio]) {
    return { platform: manualAssignments[schemeFolio], confidence: 'MANUAL', reason: 'Manually assigned', needsConfirmation: false };
  }
  if (schemeIsin && manualAssignments[schemeIsin]) {
    return { platform: manualAssignments[schemeIsin], confidence: 'MANUAL', reason: 'Manually assigned', needsConfirmation: false };
  }

  // 2. Explicit global override (when user specifically selected a named platform like "Ak ETMoney" or "Fareeda Groww")
  if (overridePlatform && overridePlatform !== 'AUTO' && overridePlatform !== 'CAMS_AUTO') {
    return { platform: overridePlatform, confidence: 'OVERRIDE', reason: 'Explicit platform override', needsConfirmation: false };
  }

  // 3. Known folio history in existing DB transactions
  if (schemeFolio && dbTransactions && dbTransactions.length > 0) {
    const matchingFolioTxns = dbTransactions.filter(t => {
      const tags = t.Tags || t.tags || '';
      return tags.includes(`Folio:${schemeFolio}`);
    });

    if (matchingFolioTxns.length > 0) {
      const subAccountCounts = {};
      for (const t of matchingFolioTxns) {
        const sa = t.SubAccount || t.sub_account || t.Brokerage || t.brokerage || t.Subcategory || t.subcategory;
        if (sa) {
          subAccountCounts[sa] = (subAccountCounts[sa] || 0) + 1;
        }
      }
      const sorted = Object.entries(subAccountCounts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0 && sorted[0][0]) {
        return { platform: sorted[0][0], confidence: 'DB_FOLIO_HISTORY', reason: 'Matched by existing folio history', needsConfirmation: false };
      }
    }
  }

  // 4. Known advisor / broker registration codes from CAS text
  if (schemeAdvisor) {
    // Groww signatures: INZ000208032, EOP-0002, GROWW
    if (schemeAdvisor.includes('INZ000208032') || schemeAdvisor.includes('INZ 000208032') || schemeAdvisor.includes('EOP-0002') || schemeAdvisor.includes('GROWW')) {
      const growwSub = (existingSubAccounts || []).find(sa => {
        const s = sa.toLowerCase();
        if (s.includes('groww')) {
          if (investorName.includes('FAREEDA') && s.includes('fareeda')) return true;
          if (investorName.includes('HASEENA') && (s.includes('ammi') || s.includes('haseena'))) return true;
          if (investorName.includes('AKBAR') && s.includes('ak')) return true;
          return true;
        }
        return false;
      });
      if (growwSub) {
        return { platform: growwSub, confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
      }
      if (investorName.includes('FAREEDA')) return { platform: 'Fareeda Groww', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
      if (investorName.includes('HASEENA')) return { platform: 'Ammi Groww', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
      if (investorName.includes('AKBAR')) return { platform: 'Ak Groww', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
      return { platform: 'Groww', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
    }

    // ETMoney signatures: INA100006898, SWMPLON, ETMONEY, ET MONEY
    if (schemeAdvisor.includes('INA100006898') || schemeAdvisor.includes('INA 100006898') || schemeAdvisor.includes('SWMPLON') || schemeAdvisor.includes('ETMONEY') || schemeAdvisor.includes('ET MONEY')) {
      const etSub = (existingSubAccounts || []).find(sa => {
        const s = sa.toLowerCase();
        if (s.includes('etmoney') || s.includes('et money')) {
          if (investorName.includes('FAREEDA') && s.includes('fareeda')) return true;
          if (investorName.includes('AKBAR') && s.includes('ak')) return true;
          return true;
        }
        return false;
      });
      if (etSub) {
        return { platform: etSub, confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
      }
      if (investorName.includes('AKBAR')) return { platform: 'Ak ETMoney', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
      if (investorName.includes('FAREEDA')) return { platform: 'Fareeda ETMoney', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
      return { platform: 'ETMoney', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
    }

    // Zerodha signatures: 107023, INZ000031633, ZERODHA
    if (schemeAdvisor.includes('ZERODHA') || schemeAdvisor.includes('107023') || schemeAdvisor.includes('INZ000031633')) {
      return { platform: 'Zerodha', confidence: 'ADVISOR_CODE', reason: 'Matched by CAS broker/advisor code', needsConfirmation: false };
    }
  }

  // 5. Existing Subaccounts filtered by investor profile
  const investorKeywords = [];
  if (investorName.includes('AKBAR') || investorEmail.includes('akbar')) investorKeywords.push('ak');
  else if (investorName.includes('FAREEDA') || investorEmail.includes('fareeda')) investorKeywords.push('fareeda');
  else if (investorName.includes('HASEENA') || investorEmail.includes('mullahaseena')) investorKeywords.push('ammi', 'haseena');
  else if (investorName) {
    const firstWord = investorName.split(/\s+/)[0].toLowerCase();
    if (firstWord.length >= 2) investorKeywords.push(firstWord);
  }

  const matchingInvestorSubAccounts = (existingSubAccounts || []).filter(sa => {
    const s = sa.toLowerCase();
    return investorKeywords.some(kw => s.includes(kw));
  });

  // If exactly 1 matching subaccount exists in DB for this investor, use it confidently
  if (matchingInvestorSubAccounts.length === 1) {
    return { platform: matchingInvestorSubAccounts[0], confidence: 'SINGLE_INVESTOR_SUBACCOUNT', reason: 'Matched by investor profile', needsConfirmation: false };
  }

  // If multiple matching subaccounts exist for this investor, do not guess
  if (matchingInvestorSubAccounts.length > 1) {
    return {
      platform: matchingInvestorSubAccounts[0],
      candidatePlatforms: matchingInvestorSubAccounts,
      confidence: 'AMBIGUOUS',
      reason: 'Platform needs confirmation',
      needsConfirmation: true
    };
  }

  // 6. Generic Fallback
  const defaultInvestorPlatform = investor.platform || (investorKeywords[0] ? `${investorKeywords[0].charAt(0).toUpperCase() + investorKeywords[0].slice(1)} Mutual Funds` : 'Mutual Funds');
  return {
    platform: defaultInvestorPlatform,
    candidatePlatforms: (existingSubAccounts && existingSubAccounts.length > 0) ? existingSubAccounts : [defaultInvestorPlatform],
    confidence: 'FALLBACK',
    reason: 'Platform needs confirmation',
    needsConfirmation: true
  };
}

/**
 * Convert parsed CAS scheme and transactions into FinMan transaction objects
 */
export function generateCASTransactions({
  casData,
  platform = null,
  account = 'Liquid Mutual Funds',
  ownership = 'PERSONAL',
  dbTransactions = [],
  existingSubAccounts = [],
  overridePlatform = null,
  manualAssignments = {}
}) {
  if (!casData || !Array.isArray(casData.schemes)) {
    return { transactions: [], reconciliation: [], detectedPlatforms: [] };
  }

  const generatedTxns = [];
  const reconciliationReport = [];
  const detectedPlatformsSet = new Set();

  for (const scheme of casData.schemes) {
    const rawSchemeName = scheme.schemeName || '';
    const rawIsin = scheme.isin || '';
    const folio = scheme.folio || '';
    const mode = scheme.holdingMode || 'PHYSICAL';

    // Resolve platform/subaccount for this specific scheme
    const platformRes = resolveFolioPlatform({
      scheme,
      investor: casData.investor || {},
      dbTransactions,
      existingSubAccounts,
      overridePlatform: overridePlatform || (platform && platform !== 'Mutual Funds' ? platform : null),
      manualAssignments
    });

    const schemePlatform = platformRes.platform;
    const isNeedsConfirmation = !!platformRes.needsConfirmation;
    detectedPlatformsSet.add(schemePlatform);

    // Resolve canonical security symbol and display name
    const secRes = resolveSecurity({
      security: rawSchemeName,
      isin: rawIsin
    });
    const canonicalISIN = secRes.isin || rawIsin;
    const canonicalSymbol = secRes.displayName || secRes.symbol || rawSchemeName;

    // Resolve appropriate investment account (Tax Saver vs Liquid MF)
    const schemeAccount = scheme.account || resolveSchemeAccount(rawSchemeName, rawIsin, account);

    const tags = `Ownership:${ownership}|Folio:${folio}|Mode:${mode}`;
    const queues = []; // Local FIFO lot queue for the scheme & folio: { qty, price, costBasis }
    let calculatedUnits = scheme.openingUnits || 0;
    let calculatedInvestedCost = 0;

    let schemeBuyCount = 0;
    let schemeSellCount = 0;

    for (const t of scheme.transactions) {
      const isBuy = t.type === 'BUY' || t.type === 'DIVIDEND_REINVEST' || t.type === 'CORPORATE_ACTION';
      const isSell = t.type === 'SELL';
      const qty = parseFloat(t.quantity) || 0;
      const price = parseFloat(t.unitPrice) || 0;
      const tradeVal = parseFloat(t.tradeValue) || 0;
      const stampDuty = parseFloat(t.stampDuty) || 0;
      const totalAcquisitionCost = tradeVal + stampDuty;

      let costBasis = 0;
      let realizedPnl = 0;

      if (isBuy) {
        costBasis = totalAcquisitionCost;
        queues.push({ qty, price, costBasis });
        calculatedUnits += qty;
        calculatedInvestedCost += costBasis;
        schemeBuyCount++;
      } else if (isSell) {
        schemeSellCount++;
        let remainingToSell = qty;
        let consumedCost = 0;

        while (remainingToSell > 0 && queues.length > 0) {
          const lot = queues[0];
          if (lot.qty <= remainingToSell) {
            consumedCost += lot.costBasis;
            remainingToSell -= lot.qty;
            queues.shift();
          } else {
            const fraction = remainingToSell / lot.qty;
            const partialCost = lot.costBasis * fraction;
            consumedCost += partialCost;
            lot.costBasis -= partialCost;
            lot.qty -= remainingToSell;
            remainingToSell = 0;
          }
        }

        // Fallback for missing historical buy lots: assume cost = proceeds (no fake gain/loss)
        if (remainingToSell > 0) {
          consumedCost += remainingToSell * price;
        }

        costBasis = parseFloat(consumedCost.toFixed(2));
        realizedPnl = parseFloat((tradeVal - costBasis).toFixed(2));
        calculatedUnits -= qty;
        calculatedInvestedCost = Math.max(0, calculatedInvestedCost - costBasis);
      }

      // Generate deterministic stable key
      const stableKey = `CAMS_CAS|${schemePlatform}|${canonicalISIN}|${folio}|${mode}|${t.date}|${t.type}|${qty.toFixed(4)}|${price.toFixed(4)}|${tradeVal.toFixed(2)}`;
      const id = hashString(stableKey);

      const note = `${canonicalSymbol}`;
      const desc = `CAS MF ${t.type} | Scheme=${canonicalSymbol} | ISIN=${canonicalISIN} | Folio=${folio} | Mode=${mode} | Units=${qty} | NAV=${price} | Amount=${tradeVal} | StampDuty=${stampDuty} | CostBasis=${costBasis} | RealizedPL=${realizedPnl} | Source=CAMS_CAS`;

      generatedTxns.push({
        ID: id,
        id,
        Date: t.date,
        Time: '12:00',
        Account: schemeAccount,
        FromAccount: schemeAccount,
        ToAccount: schemeAccount,
        Category: schemeAccount,
        Subcategory: schemePlatform,
        Note: note,
        Description: desc,
        INR: 0,
        Amount: String(tradeVal),
        Currency: 'INR',
        'Income/Expense': 'Transfer-Out',
        Tags: tags,
        SubAccount: schemePlatform,
        FromSubAccount: schemePlatform,
        ToSubAccount: schemePlatform,
        InvestmentTransactionType: t.type,
        Brokerage: schemePlatform,
        SecuritySymbol: canonicalSymbol,
        SecurityISIN: canonicalISIN,
        Quantity: qty,
        UnitPrice: price,
        TradeValue: tradeVal,
        CostBasis: costBasis,
        CashImpact: 0, // CRITICAL: Zero cash impact to preserve bank account balances
        PositionQuantityChange: isSell ? -qty : qty,
        RealizedPnl: realizedPnl,
        Source: 'CAMS_CAS'
      });
    }

    // Scheme Reconciliation Audit
    const expectedClosingUnits = scheme.closingUnits || 0;
    const diffUnits = Math.abs(calculatedUnits - expectedClosingUnits);
    const passed = diffUnits < 0.005;

    reconciliationReport.push({
      isin: canonicalISIN,
      schemeName: canonicalSymbol,
      account: schemeAccount,
      platform: schemePlatform,
      confidence: platformRes.confidence,
      reason: platformRes.reason || 'Matched automatically',
      needsConfirmation: isNeedsConfirmation,
      candidatePlatforms: platformRes.candidatePlatforms || [],
      folio,
      holdingMode: mode,
      buyCount: schemeBuyCount,
      sellCount: schemeSellCount,
      calculatedUnits: parseFloat(calculatedUnits.toFixed(3)),
      expectedClosingUnits: parseFloat(expectedClosingUnits.toFixed(3)),
      unitDifference: parseFloat(diffUnits.toFixed(3)),
      status: passed ? 'PASSED' : 'DISCREPANCY',
      closingCostValue: scheme.closingCostValue || 0,
      closingMarketValue: scheme.closingMarketValue || 0
    });
  }

  return {
    transactions: generatedTxns,
    reconciliation: reconciliationReport,
    detectedPlatforms: Array.from(detectedPlatformsSet)
  };
}

/**
 * Date helper for economic matching
 */
function parseDMY(dStr) {
  if (!dStr) return null;
  const str = String(dStr).split('T')[0];
  const parts = str.split(/[\/\-]/);
  if (parts.length === 3) {
    // If format is YYYY-MM-DD
    if (parts[0].length === 4) {
      return new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
    }
    // If format is DD/MM/YYYY
    const d = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const y = parseInt(parts[2], 10);
    return new Date(Date.UTC(y, m, d));
  }
  return null;
}

function daysDiff(d1Str, d2Str) {
  const dt1 = parseDMY(d1Str);
  const dt2 = parseDMY(d2Str);
  if (!dt1 || !dt2) return 999;
  return Math.abs((dt1.getTime() - dt2.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Economic Matcher: Matches an incoming CAS transaction against existing DB investment transactions.
 * Accounts for 1-3 day bank debit vs allotment date variance, ISIN aliases, non-cash corporate actions,
 * and preserves existing ownership without overwriting.
 */
export function matchCASTransactionAgainstDB(casTxn, dbRows, matchedIds = new Set()) {
  const casIsin = (casTxn.SecurityISIN || '').toUpperCase();
  const casQty = parseFloat(casTxn.Quantity) || 0;
  const casVal = parseFloat(casTxn.TradeValue || casTxn.Amount || 0);
  const casType = casTxn.InvestmentTransactionType;

  let bestMatch = null;
  let matchCategory = null;

  for (const db of dbRows) {
    const dbId = db.ID || db.id;
    if (matchedIds.has(dbId)) continue;

    const dbIsin = (db.SecurityISIN || db.security_isin || '').toUpperCase();
    const isinMatch = (dbIsin === casIsin) ||
      (casIsin === 'INF090I01VK0' && dbIsin === 'INF090I01JA6') ||
      (casIsin === 'INF090I01JA6' && dbIsin === 'INF090I01VK0');

    if (!isinMatch) continue;

    const dbQty = parseFloat(db.Quantity ?? db.quantity) || 0;
    const dbVal = parseFloat(db.TradeValue ?? db.trade_value ?? db.Amount ?? db.amount ?? db.INR ?? db.inr ?? 0);
    const dbType = db.InvestmentTransactionType || db.investment_transaction_type || (db['Income/Expense'] === 'Transfer-Out' ? 'BUY' : 'SELL');

    const isSameQty = Math.abs(dbQty - casQty) < 0.005;
    const isDirectionMatch = (dbType === casType) ||
      (casType === 'CORPORATE_ACTION' && (dbType === 'UNIT_ADJUSTMENT' || dbType === 'BUY')) ||
      (dbType === 'CORPORATE_ACTION' && (casType === 'UNIT_ADJUSTMENT' || casType === 'BUY'));

    if (!isSameQty || !isDirectionMatch) continue;

    const dbDate = db.Date || db.date || db.SettlementDate || db.settlement_date;
    const isExactDate = (dbDate === casTxn.Date);
    const diff = daysDiff(dbDate, casTxn.Date);
    const isCloseDate = diff <= 4;
    const isSameVal = Math.abs(dbVal - casVal) < 1.0;

    if (isExactDate && isSameVal) {
      bestMatch = db;
      matchCategory = 'EXACT';
      break;
    } else if (isCloseDate && (!bestMatch || matchCategory === 'PROBABLE_EXTENDED_DATE')) {
      bestMatch = db;
      matchCategory = 'PROBABLE_DATE_VARIANCE';
    } else if (!bestMatch) {
      bestMatch = db;
      matchCategory = 'PROBABLE_EXTENDED_DATE';
    }
  }

  return { match: bestMatch, matchCategory };
}

/**
 * Reconciles an entire array of CAS transactions against DB records.
 * Computes exact matches, date variances, account routing summaries, platform breakdown, and isolates truly new rows.
 */
export function reconcileCASTransactionsWithDB({ casTransactions = [], dbTransactions = [] }) {
  const matchedIds = new Set();
  const matchedRecords = [];
  const trulyNewRows = [];

  let exactMatches = 0;
  let probableDateVariance = 0;
  let probableExtended = 0;
  let ownershipConflicts = 0;
  let folioPlatformConflicts = 0;

  const routingSummary = {};
  const platformSummary = {};

  for (const cas of casTransactions) {
    // Track account routing
    const acctRouteKey = `${cas.Account} → ${cas.SubAccount || cas.Brokerage || 'SubAccount'}`;
    routingSummary[acctRouteKey] = (routingSummary[acctRouteKey] || 0) + 1;

    // Track platform counts
    const platKey = cas.SubAccount || cas.Brokerage || 'Platform';
    platformSummary[platKey] = (platformSummary[platKey] || 0) + 1;

    const { match, matchCategory } = matchCASTransactionAgainstDB(cas, dbTransactions, matchedIds);

    if (match) {
      const dbId = match.ID || match.id;
      matchedIds.add(dbId);
      matchedRecords.push({ cas, db: match, matchCategory });

      if (matchCategory === 'EXACT') {
        exactMatches++;
      } else if (matchCategory === 'PROBABLE_DATE_VARIANCE') {
        probableDateVariance++;
      } else {
        probableExtended++;
      }

      // Check ownership compatibility
      const dbTags = match.Tags || match.tags || '';
      const casTags = cas.Tags || '';
      if (dbTags.includes('Ownership:EXTERNAL') && casTags.includes('Ownership:PERSONAL')) {
        // Ownership intentionally set in DB — preserved, no conflict
      }
    } else {
      trulyNewRows.push(cas);
    }
  }

  const totalEvents = casTransactions.length;
  const alreadyInDatabase = matchedRecords.length;
  const newTransactions = trulyNewRows.length;

  return {
    totalEvents,
    alreadyInDatabase,
    newTransactions,
    exactMatches,
    probableDateVariance: probableDateVariance + probableExtended,
    ownershipConflicts,
    folioPlatformConflicts,
    routingSummary,
    platformSummary,
    trulyNewRows,
    matchedRecords
  };
}
