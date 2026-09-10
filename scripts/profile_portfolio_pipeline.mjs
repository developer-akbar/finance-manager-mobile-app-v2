import { getUnifiedPortfolioData } from '../src/utils/portfolioSelector.js';
import { ValuationProvider } from '../src/utils/valuationProvider.js';
import { computePortfolioXIRR, computePortfolio1DReturns, aggregatePositionsForDisplay, matchesHoldingSearch } from '../src/utils/portfolioAggregation.js';
import { parseMutualFundTransaction } from '../src/utils/mutualFundPositionEngine.js';
import { parseTxnFields } from '../src/utils/brokerageAccounting.js';

// Build a realistic synthetic dataset with 5,000 transactions (MF, Equities, Expenses, Incomes, Transfers)
const generateTestData = () => {
  const txns = [];
  const funds = [
    { isin: 'INF247L01AC1', name: 'Motilal Oswal Nifty Next 50', acct: 'Liquid Mutual Funds', sub: 'Fareeda Groww', tag: 'EXTERNAL' },
    { isin: 'INF966L01986', name: 'Quant ELSS Tax Saver Fund', acct: 'Mutual Funds Tax Saver', sub: 'Ak ETMoney', tag: 'PERSONAL' },
    { isin: 'INF769K01DM9', name: 'Mirae Asset ELSS Tax Saver', acct: 'Mutual Funds Tax Saver', sub: 'Ak ETMoney', tag: 'PERSONAL' },
    { isin: 'INF879O01027', name: 'Parag Parikh Flexi Cap', acct: 'Liquid Mutual Funds', sub: 'Fareeda Groww', tag: 'PERSONAL' },
    { isin: 'INF204K01XI3', name: 'Nippon India Large Cap', acct: 'Liquid Mutual Funds', sub: 'Ammi Groww', tag: 'EXTERNAL' }
  ];

  const stocks = ['RELIANCE.NS', 'TCS.NS', 'INFY.NS', 'HDFCBANK.NS', 'TATAMTRDVR.NS', 'VISESHINFO.NS'];

  for (let i = 0; i < 5000; i++) {
    if (i < 200) {
      const f = funds[i % funds.length];
      txns.push({
        id: `txn-mf-${i}`,
        Date: `01/${String((i % 12) + 1).padStart(2, '0')}/2024`,
        Account: f.acct,
        SubAccount: f.sub,
        Category: f.acct,
        Note: f.name,
        INR: 500,
        Amount: '500',
        'Income/Expense': 'BUY',
        InvestmentTransactionType: 'BUY',
        SecurityISIN: f.isin,
        SecuritySymbol: f.name,
        SecurityDisplayName: f.name,
        Quantity: 25,
        UnitPrice: 20,
        TradeValue: 500,
        Tags: `Ownership:${f.tag}|Folio:910121381854/0|Mode:DEMAT`,
        OwnershipTag: f.tag,
        FolioNumber: '910121381854/0',
        HoldingMode: 'DEMAT'
      });
    } else if (i < 400) {
      const sym = stocks[i % stocks.length];
      txns.push({
        id: `txn-eq-${i}`,
        Date: `05/${String((i % 12) + 1).padStart(2, '0')}/2024`,
        Account: 'Share Market',
        SubAccount: 'Zerodha',
        Category: 'Share Market',
        Note: sym,
        INR: 1000,
        Amount: '1000',
        'Income/Expense': 'BUY',
        InvestmentTransactionType: 'BUY',
        SecuritySymbol: sym,
        Quantity: 10,
        UnitPrice: 100,
        TradeValue: 1000,
        Tags: 'Ownership:PERSONAL|Brokerage:Zerodha'
      });
    } else {
      txns.push({
        id: `txn-gen-${i}`,
        Date: `10/${String((i % 12) + 1).padStart(2, '0')}/2024`,
        Account: 'HDFC Bank',
        SubAccount: '',
        Category: 'Food',
        Subcategory: 'Groceries',
        Note: 'Daily grocery',
        INR: 150,
        Amount: '150',
        'Income/Expense': 'Expense'
      });
    }
  }
  return txns;
};

const txns = generateTestData();
console.log(`Generated ${txns.length} test transactions.`);

// Measure A: Initial Portfolio Data Calculation
const t0 = performance.now();
const rawPortfolio = getUnifiedPortfolioData(txns, {});
const t1 = performance.now();
console.log(`A. getUnifiedPortfolioData calculation time: ${(t1 - t0).toFixed(2)}ms (Positions: ${rawPortfolio.allPositions.length})`);

// Measure B & C: Live Valuation Fetching
const provider = new ValuationProvider();
const activePositions = rawPortfolio.allPositions.filter(p => p.status === 'ACTIVE');
const t2 = performance.now();
const valRes1 = await provider.fetchAllValuations(activePositions);
const t3 = performance.now();
console.log(`B. First fetchAllValuations (cold): ${(t3 - t2).toFixed(2)}ms (Valued: ${valRes1.valuedCount}/${valRes1.totalPositions})`);

// Measure D: Second fetch (cached)
const t4 = performance.now();
const valRes2 = await provider.fetchAllValuations(activePositions);
const t5 = performance.now();
console.log(`D. Second fetchAllValuations (warm cache): ${(t5 - t4).toFixed(2)}ms`);

// Measure E: summaryMetrics calculation
const t6 = performance.now();
const xirr = computePortfolioXIRR(activePositions, provider);
const returns1D = computePortfolio1DReturns(activePositions, provider);
const t7 = performance.now();
console.log(`E. Metrics calculation (XIRR + 1D returns): ${(t7 - t6).toFixed(2)}ms`);

// Measure F: Scope change
const t8 = performance.now();
const extPositions = rawPortfolio.allPositions.filter(p => p.ownershipTag === 'EXTERNAL');
const extAgg = aggregatePositionsForDisplay(extPositions, provider);
const t9 = performance.now();
console.log(`F. Scope filter change -> aggregation: ${(t9 - t8).toFixed(2)}ms (Groups: ${extAgg.length})`);

// Measure G: Search filtering
const t10 = performance.now();
const matches = extAgg.filter(g => matchesHoldingSearch(g, 'Motilal Nifty Next 50'));
const t11 = performance.now();
console.log(`G. Search filter match time: ${(t11 - t10).toFixed(2)}ms (Matches: ${matches.length})`);
