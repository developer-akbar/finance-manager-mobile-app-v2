const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { getUnifiedPortfolioData } = require('../src/utils/portfolioSelector.js');
const { defaultValuationProvider } = require('../src/utils/valuationProvider.js');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05_latest.csv');
const csvContent = fs.readFileSync(csvPath, 'utf8');
const transactions = parseCSV(csvContent);

console.log('=== FINMAN PORTFOLIO DASHBOARD RECONCILIATION AUDIT ===\n');

const rawPortfolio = getUnifiedPortfolioData(transactions, {});
const { allPositions, brokerageCashMap, totalBrokerageCash } = rawPortfolio;

function evaluateScope(scopeFilter, platformFilter = 'all', accountFilter = 'all') {
  // 1. Scope filter
  let scoped = allPositions;
  if (scopeFilter === 'personal') {
    scoped = allPositions.filter(p => p.ownershipTag === 'PERSONAL' || p.ownershipTag === 'MIXED_HOLDING');
  } else if (scopeFilter === 'father') {
    scoped = allPositions.filter(p => p.ownershipTag === 'FATHER_EXTERNAL');
  }

  // 2. Platform & Account filter
  const displayed = scoped.filter(p => {
    if (platformFilter !== 'all' && p.subAccount !== platformFilter) return false;
    if (accountFilter !== 'all' && p.investmentAccount !== accountFilter) return false;
    return true;
  });

  const activeHoldings = displayed.filter(p => p.status === 'ACTIVE');
  const redeemedHoldings = displayed.filter(p => p.status === 'REDEEMED');
  const dataIssues = displayed.filter(p => p.status === 'LEGACY_DATA_ISSUE');

  const activeCostBasis = activeHoldings.reduce((sum, p) => sum + (p.remainingCostBasis || 0), 0);
  const realizedPnl = displayed.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);

  let valuedCurrentValue = 0;
  let valuedCostBasis = 0;
  let valuedCount = 0;

  for (const p of activeHoldings) {
    const v = defaultValuationProvider.getValuation(p);
    if (v && v.isValued) {
      valuedCurrentValue += (v.currentValue || 0);
      valuedCostBasis += (p.remainingCostBasis || 0);
      valuedCount++;
    }
  }

  const totalActiveCount = activeHoldings.length;
  const isFullyValued = totalActiveCount > 0 && valuedCount === totalActiveCount;
  const hasPartialValuation = valuedCount > 0;
  const valuedUnrealizedPnl = hasPartialValuation ? Math.round((valuedCurrentValue - valuedCostBasis) * 100) / 100 : 0;

  // Brokerage cash logic: Brokerage cash ONLY applies if scope/account includes Share Market brokerage context
  let relevantBrokerageCash = 0;
  const includesShareMarket = (accountFilter === 'all' || accountFilter === 'Share Market');
  const isPersonalScope = (scopeFilter === 'personal' || scopeFilter === 'all');

  if (isPersonalScope && includesShareMarket) {
    if (platformFilter !== 'all') {
      relevantBrokerageCash = brokerageCashMap[platformFilter] || 0;
    } else {
      relevantBrokerageCash = totalBrokerageCash;
    }
  }

  return {
    scopeFilter,
    platformFilter,
    accountFilter,
    activeCount: activeHoldings.length,
    redeemedCount: redeemedHoldings.length,
    dataIssuesCount: dataIssues.length,
    activeCostBasis: Math.round(activeCostBasis * 100) / 100,
    valuedCount,
    valuedCostBasis: Math.round(valuedCostBasis * 100) / 100,
    valuedCurrentValue: Math.round(valuedCurrentValue * 100) / 100,
    valuedUnrealizedPnl,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    brokerageCash: Math.round(relevantBrokerageCash * 100) / 100,
    isFullyValued,
    hasPartialValuation
  };
}

const scopesToTest = [
  { name: 'A. My Portfolio (Personal Scope)', scope: 'personal', platform: 'all', account: 'all' },
  { name: "B. Father's Holdings (Father Scope)", scope: 'father', platform: 'all', account: 'all' },
  { name: 'C. All Holdings (Combined Scope)', scope: 'all', platform: 'all', account: 'all' },
  { name: 'D. Share Market (My Portfolio)', scope: 'personal', platform: 'all', account: 'Share Market' },
  { name: 'E. Liquid Mutual Funds (My Portfolio)', scope: 'personal', platform: 'all', account: 'Liquid Mutual Funds' },
  { name: 'F. Mutual Funds Tax Saver (My Portfolio)', scope: 'personal', platform: 'all', account: 'Mutual Funds Tax Saver' },
  { name: 'G. Share Market + Fareeda Groww', scope: 'personal', platform: 'Fareeda Groww', account: 'Share Market' },
  { name: 'H. Share Market + Zerodha', scope: 'personal', platform: 'Zerodha', account: 'Share Market' }
];

console.log('RECONCILIATION TABLE:');
console.log('-------------------------------------------------------------------------------------------------------------------------');
console.log(
  'Scope Name'.padEnd(42) +
  'Active Cost'.padStart(14) +
  'Valued Cost'.padStart(14) +
  'Current Val'.padStart(14) +
  'Unrealized'.padStart(12) +
  'Realized PnL'.padStart(14) +
  'Cash'.padStart(12)
);
console.log('-------------------------------------------------------------------------------------------------------------------------');

for (const s of scopesToTest) {
  const res = evaluateScope(s.scope, s.platform, s.account);
  console.log(
    s.name.padEnd(42) +
    `₹${res.activeCostBasis.toLocaleString('en-IN')}`.padStart(14) +
    `₹${res.valuedCostBasis.toLocaleString('en-IN')}`.padStart(14) +
    `₹${res.valuedCurrentValue.toLocaleString('en-IN')}`.padStart(14) +
    `₹${res.valuedUnrealizedPnl.toLocaleString('en-IN')}`.padStart(12) +
    `₹${res.realizedPnl.toLocaleString('en-IN')}`.padStart(14) +
    `₹${res.brokerageCash.toLocaleString('en-IN')}`.padStart(12)
  );
}

console.log('-------------------------------------------------------------------------------------------------------------------------\n');

// Detail Data Issue check
console.log('DATA ISSUE INVESTIGATION:');
const issues = allPositions.filter(p => p.status === 'LEGACY_DATA_ISSUE');
console.log(`Found ${issues.length} position(s) with LEGACY_DATA_ISSUE:`);
issues.forEach(p => {
  console.log(`- Position: ${p.positionKey}, Note: ${p.note}, Reason: ${p.issueReason || 'Legacy transaction format'}`);
});
