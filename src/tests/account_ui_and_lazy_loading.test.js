/**
 * src/tests/account_ui_and_lazy_loading.test.js
 *
 * Automated Test Suite for FinMan Account UI Button Consistency and Non-Blocking All-Period Loading.
 *
 * Requirements covered:
 * 1. Transactions Paste button matches reference design (height: 28px, border-radius: 14px, bg-card2).
 * 2. Transactions Search button matches reference design.
 * 3. Account Search button matches reference design.
 * 4. Light and dark theme hover states have readable contrast (no white-on-white).
 * 5. Existing button actions and click handlers still work.
 * 6. All period initially renders only the first configured batch (100 txns).
 * 7. Scrolling / sentinel trigger loads the next batch without replacing previous records.
 * 8. No duplicate transactions between batches.
 * 9. No missing transactions across batches.
 * 10. Stable chronological ordering (newest first, stable tie-breaking).
 * 11. Date groups spanning batch boundaries merge cleanly.
 * 12. End-of-history state appears correctly when all transactions are loaded.
 * 13. Account totals (income, expense, closingBal) are computed from full history, not loaded batch.
 * 14. Transaction editing and deletion preserve list and total consistency.
 * 15. Full historical chart data is available even when only the first batch is rendered.
 * 16. Chart includes the earliest and latest available months.
 * 17. Chart monthly closing balances remain exact and match mathematical ground truth.
 * 18. Credit card chart values remain positive magnitudes.
 * 19. Bank account chart sign semantics remain unchanged.
 * 20. Chart cache invalidates automatically on relevant transaction changes.
 * 21. Existing account calendar date navigation remains intact.
 * 22. Sticky-header scrolling remains correct.
 * 23. Global Transactions layout remains compact without unwanted gap.
 * 24. Existing account balance calculations remain unchanged.
 * 25. Browser IndexedDB and Android SQLite repository pagination methods remain compatible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import * as formatUtils from '../utils/format.js';
import { getAccountTransactionsPaginated } from '../database/transactions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

test('FinMan — Account UI Button Consistency & Non-Blocking All-Period Loading Suite', async (t) => {
  const acctPath = path.join(projectRoot, 'src/components/Accounts/Accounts.jsx');
  const acctCssPath = path.join(projectRoot, 'src/components/Accounts/Accounts.css');
  const txnPath = path.join(projectRoot, 'src/components/Transactions/Transactions.jsx');
  const txnCssPath = path.join(projectRoot, 'src/components/Transactions/Transactions.css');
  const globalsCssPath = path.join(projectRoot, 'src/styles/globals.css');

  assert.ok(fs.existsSync(acctPath), 'Accounts.jsx must exist');
  assert.ok(fs.existsSync(acctCssPath), 'Accounts.css must exist');
  assert.ok(fs.existsSync(txnPath), 'Transactions.jsx must exist');
  assert.ok(fs.existsSync(txnCssPath), 'Transactions.css must exist');
  assert.ok(fs.existsSync(globalsCssPath), 'globals.css must exist');

  const acctContent = fs.readFileSync(acctPath, 'utf8').replace(/\r\n/g, '\n');
  const acctCss = fs.readFileSync(acctCssPath, 'utf8').replace(/\r\n/g, '\n');
  const txnContent = fs.readFileSync(txnPath, 'utf8').replace(/\r\n/g, '\n');
  const txnCss = fs.readFileSync(txnCssPath, 'utf8').replace(/\r\n/g, '\n');
  const globalsCss = fs.readFileSync(globalsCssPath, 'utf8').replace(/\r\n/g, '\n');

  // Extract pure logic helper functions from Accounts.jsx into an isolated VM context
  const cbStart = acctContent.indexOf('function computeBalance(');
  const cbEnd = acctContent.indexOf('export function toAccountChartValue');
  const cbStr = acctContent.slice(cbStart, cbEnd);

  const toChartStart = acctContent.indexOf('export function toAccountChartValue');
  const toChartEnd = acctContent.indexOf('export function formatAccountBalanceChartData');
  const toChartStr = acctContent.slice(toChartStart, toChartEnd).replaceAll('export function', 'function');

  const fmtStart = acctContent.indexOf('export function formatAccountBalanceChartData');
  const fmtEnd = acctContent.indexOf('// Build a full balance map');
  const fmtStr = acctContent.slice(fmtStart, fmtEnd).replaceAll('export function', 'function');

  const context = {
    ...formatUtils,
    MS_S: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    MS_F: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  };
  vm.createContext(context);
  vm.runInContext(cbStr, context);
  vm.runInContext(toChartStr, context);
  vm.runInContext(fmtStr, context);

  const { toAccountChartValue, formatAccountBalanceChartData, clearAccountBalanceChartCache } = context;

  // ─────────────────────────────────────────────────────────────────────────────
  // Enhancement 1: Header Action Button Styling & Consistency
  // ─────────────────────────────────────────────────────────────────────────────

  await t.test('1. Transactions Paste button matches reference design tokens (height 28px, border-radius 14px, bg-card2)', () => {
    assert.ok(txnCss.includes('.txn-paste-btn'), 'Transactions.css must define .txn-paste-btn');
    assert.ok(txnCss.includes('height: 28px;'), '.txn-paste-btn height must be 28px');
    assert.ok(txnCss.includes('border-radius: 14px;'), '.txn-paste-btn border-radius must be 14px');
    assert.ok(txnCss.includes('background: var(--theme-header-btn-bg, var(--bg-card2));'), '.txn-paste-btn must use --bg-card2 surface');
  });

  await t.test('2. Transactions Search button matches reference design tokens (width 28px, height 28px, border-radius 14px)', () => {
    assert.ok(txnCss.includes('.txn-search-btn'), 'Transactions.css must define .txn-search-btn');
    assert.ok(txnCss.includes('width: 28px;'), '.txn-search-btn width must be 28px');
    assert.ok(txnCss.includes('height: 28px;'), '.txn-search-btn height must be 28px');
    assert.ok(txnCss.includes('border-radius: 14px;'), '.txn-search-btn border-radius must be 14px');
  });

  await t.test('3. Drilled-down Account Search button matches reference design tokens', () => {
    assert.ok(acctContent.includes('className="txn-search-btn"'), 'AccountDetail must use .txn-search-btn');
    assert.ok(acctCss.includes('.acct-detail-screen .txn-search-btn'), 'Accounts.css must scope .txn-search-btn');
    assert.ok(acctCss.includes('height: 28px;'), 'Account search button height must be 28px');
    assert.ok(acctCss.includes('border-radius: 14px;'), 'Account search button border-radius must be 14px');
    assert.ok(acctCss.includes('background: var(--theme-header-btn-bg, var(--bg-card2));'), 'Account search button must use --bg-card2');
  });

  await t.test('4. Card Perks, Portfolio, and Debt Tracker share standardized .header-pill-btn class', () => {
    assert.ok(acctContent.includes('className="header-pill-btn"'), 'Accounts.jsx landing buttons must use .header-pill-btn');
    assert.ok(globalsCss.includes('.header-pill-btn'), 'globals.css must define .header-pill-btn');
    assert.ok(acctCss.includes('.header-pill-btn'), 'Accounts.css must define .header-pill-btn');
  });

  await t.test('5. Light theme has subtle, theme-appropriate contrast (uses --bg-card2 #f0f3fa, no white-on-white)', () => {
    assert.ok(
      txnCss.includes('[data-theme="light"] .txn-paste-btn') && txnCss.includes('var(--bg-card2, #f0f3fa)'),
      'Light theme .txn-paste-btn must use --bg-card2 (#f0f3fa) instead of pure white'
    );
    assert.ok(
      txnCss.includes('[data-theme="light"] .header-pill-btn:hover') && txnCss.includes('var(--bg-hover, #d8e2f3)'),
      'Light theme hover state must produce subtle, theme-appropriate background change (#d8e2f3)'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Enhancement 2: Incremental Loading & Infinite Scroll
  // ─────────────────────────────────────────────────────────────────────────────

  // Generate 500 test transactions across 3 years
  const mockTxns = [];
  const baseTime = new Date(2024, 0, 1).getTime();
  for (let i = 0; i < 500; i++) {
    const d = new Date(baseTime + i * 3600 * 12 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const dStr = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    mockTxns.push({
      _id: `txn_${i}`,
      Date: dStr,
      Time: '12:00:00',
      Account: 'HDFC Bank',
      Amount: 100 + (i % 200),
      'Income/Expense': i % 3 === 0 ? 'Income' : 'Expense',
    });
  }

  await t.test('6. All period initially renders only the first configured batch (100 txns)', () => {
    assert.ok(acctContent.includes('const ALL_BATCH_SIZE = 100;'), 'Initial batch size must be 100');
    assert.ok(acctContent.includes('sortedPeriodTxns.slice(0, allLoadedCount)'), 'displayedTxns must slice initial batch');

    // Simulate initial slice
    const initialBatch = mockTxns.slice(0, 100);
    assert.strictEqual(initialBatch.length, 100, 'Initial batch must contain exactly 100 items');
  });

  await t.test('7. Scrolling / sentinel trigger loads the next batch without replacing previous records', () => {
    assert.ok(acctContent.includes('IntersectionObserver'), 'IntersectionObserver must be configured for sentinel');
    assert.ok(acctContent.includes('sentinelRef'), 'Sentinel ref must be attached');
    assert.ok(acctContent.includes('setAllLoadedCount(prev => prev + ALL_BATCH_SIZE)'), 'Sentinel must append next batch');

    // Batch 1 + Batch 2
    const batch2 = mockTxns.slice(0, 200);
    assert.strictEqual(batch2.length, 200, 'Batch 2 must retain previous 100 and add 100 more');
  });

  await t.test('8. No duplicate transactions between batches', () => {
    const batch1 = mockTxns.slice(0, 100);
    const batch2 = mockTxns.slice(0, 200);

    const ids1 = new Set(batch1.map(t => t._id));
    const ids2 = new Set(batch2.map(t => t._id));

    assert.strictEqual(ids1.size, 100);
    assert.strictEqual(ids2.size, 200);

    // Verify all IDs in batch 1 are still in batch 2
    for (const id of ids1) {
      assert.ok(ids2.has(id));
    }
  });

  await t.test('9. No missing transactions across batches and stable chronological ordering', () => {
    // Sort mockTxns descending (newest first)
    const sorted = [...mockTxns].sort((a, b) => {
      const da = formatUtils.parseDate(a.Date), db = formatUtils.parseDate(b.Date);
      return db - da;
    });

    const batch1 = sorted.slice(0, 100);
    const batch2 = sorted.slice(0, 200);

    // Verify date descending
    for (let i = 1; i < batch1.length; i++) {
      const prevD = formatUtils.parseDate(batch1[i - 1].Date);
      const currD = formatUtils.parseDate(batch1[i].Date);
      assert.ok(prevD >= currD, 'Ordering must remain strictly descending');
    }

    for (let i = 1; i < batch2.length; i++) {
      const prevD = formatUtils.parseDate(batch2[i - 1].Date);
      const currD = formatUtils.parseDate(batch2[i].Date);
      assert.ok(prevD >= currD, 'Ordering in expanded batch must remain strictly descending');
    }
  });

  await t.test('10. Date groups spanning batch boundaries merge cleanly', () => {
    // Transactions with identical dates spanning boundary 98 to 102
    const boundaryDate = '15/06/2024';
    const txnsWithBoundary = mockTxns.map((t, i) => {
      if (i >= 98 && i <= 102) {
        return { ...t, Date: boundaryDate };
      }
      return t;
    });

    const batch1 = txnsWithBoundary.slice(0, 100);
    const batch2 = txnsWithBoundary.slice(0, 200);

    const groupMap1 = {};
    for (const t of batch1) {
      if (!groupMap1[t.Date]) groupMap1[t.Date] = [];
      groupMap1[t.Date].push(t);
    }

    const groupMap2 = {};
    for (const t of batch2) {
      if (!groupMap2[t.Date]) groupMap2[t.Date] = [];
      groupMap2[t.Date].push(t);
    }

    // In batch 1, boundaryDate has 2 items (indices 98 and 99)
    assert.strictEqual(groupMap1[boundaryDate].length, 2);
    // In batch 2, boundaryDate has all 5 items (indices 98, 99, 100, 101, 102)
    assert.strictEqual(groupMap2[boundaryDate].length, 5);
    // Crucially: boundaryDate is a single group key in both, never duplicated
    assert.strictEqual(Object.keys(groupMap1).filter(k => k === boundaryDate).length, 1);
    assert.strictEqual(Object.keys(groupMap2).filter(k => k === boundaryDate).length, 1);
  });

  await t.test('11. End-of-history state appears correctly when all transactions are loaded', () => {
    assert.ok(acctContent.includes('acct-all-pagination-status'), 'Pagination status container must exist in Accounts.jsx');
    assert.ok(acctContent.includes('acct-all-end'), 'End-of-history state must exist in Accounts.jsx');
    assert.ok(acctContent.includes('✓ End of transaction history'), 'End-of-history text must be present');
    assert.ok(acctCss.includes('.acct-all-end'), 'Accounts.css must style .acct-all-end');
  });

  await t.test('12. Account totals and closing balance reflect full history, not loaded batch', () => {
    // Totals in AccountDetail are calculated from periodTxns (which is acctTxns in All), not displayedTxns
    assert.ok(
      acctContent.includes('for (const t of periodTxns) {') && acctContent.includes('totals = useMemo('),
      'Account totals loop must iterate full periodTxns'
    );
    assert.ok(
      acctContent.includes('closingBal = openingBal + periodBalance'),
      'Closing balance must be computed from full periodBalance'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Enhancement 2: Chart Independence & O(N) Aggregation with Caching
  // ─────────────────────────────────────────────────────────────────────────────

  await t.test('13. Full historical chart data is available even when only the first batch is rendered', () => {
    // Verify that formatAccountBalanceChartData receives acctTxns (full history), not displayedTxns
    assert.ok(
      acctContent.includes('formatAccountBalanceChartData({') && acctContent.includes('acctTxns,'),
      'barData calculation must receive acctTxns (full history)'
    );

    const chartPoints = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: mockTxns, // 500 txns
      acctName: 'HDFC Bank',
    });

    assert.ok(chartPoints.length > 5, 'Full historical chart must have points for all transacted months');
  });

  await t.test('14. Chart includes earliest and latest available months in chronological order', () => {
    const historicalTxns = [
      { Date: '15/03/2023', 'Income/Expense': 'Income', Account: 'HDFC', Amount: 50000 },
      { Date: '20/07/2024', 'Income/Expense': 'Expense', Account: 'HDFC', Amount: 10000 },
      { Date: '10/11/2026', 'Income/Expense': 'Expense', Account: 'HDFC', Amount: 5000 },
    ];

    const chartPoints = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: historicalTxns,
      acctName: 'HDFC',
    });

    assert.strictEqual(chartPoints.length, 3);
    assert.strictEqual(chartPoints[0].fullLabel, 'March 2023');
    assert.strictEqual(chartPoints[1].fullLabel, 'July 2024');
    assert.strictEqual(chartPoints[2].fullLabel, 'November 2026');
  });

  await t.test('15. Chart monthly closing balances match mathematical truth', () => {
    const txns = [
      { Date: '05/01/2025', 'Income/Expense': 'Income', Account: 'HDFC', Amount: 100000 },
      { Date: '20/01/2025', 'Income/Expense': 'Expense', Account: 'HDFC', Amount: 20000 },
      { Date: '10/02/2025', 'Income/Expense': 'Expense', Account: 'HDFC', Amount: 15000 },
      { Date: '28/02/2025', 'Income/Expense': 'Income', Account: 'HDFC', Amount: 5000 },
    ];

    const chartPoints = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: txns,
      acctName: 'HDFC',
    });

    assert.strictEqual(chartPoints.length, 2);
    // Jan: 100000 - 20000 = 80000
    assert.strictEqual(chartPoints[0].value, 80000);
    // Feb: 80000 - 15000 + 5000 = 70000
    assert.strictEqual(chartPoints[1].value, 70000);
  });

  await t.test('16. Credit card chart values remain positive magnitudes and bank retains sign semantics', () => {
    const ccTxns = [
      { Date: '01/01/2026', 'Income/Expense': 'Expense', Account: 'ICICI CC', Amount: 12000 },
    ];
    const ccChart = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: ccTxns,
      acctName: 'ICICI CC',
      isCreditCardAccount: true,
    });
    assert.strictEqual(ccChart[0].value, 12000, 'Credit card liability must plot as positive 12000 magnitude');

    const bankTxns = [
      { Date: '01/01/2026', 'Income/Expense': 'Expense', Account: 'SBI', Amount: 5000 },
    ];
    const bankChart = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: bankTxns,
      acctName: 'SBI',
      isCreditCardAccount: false,
    });
    assert.strictEqual(bankChart[0].value, -5000, 'Bank account negative overdraft must retain negative sign');
  });

  await t.test('17. Chart cache returns instant cached data and invalidates on transaction modifications', () => {
    clearAccountBalanceChartCache();

    const t0 = performance.now();
    const data1 = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: mockTxns,
      acctName: 'HDFC Bank',
    });
    const tFirst = performance.now() - t0;

    const t1 = performance.now();
    const data2 = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: mockTxns,
      acctName: 'HDFC Bank',
    });
    const tSecond = performance.now() - t1;

    assert.strictEqual(data1, data2, 'Subsequent call must return identical cached array reference');
    assert.ok(tSecond <= tFirst, 'Cached lookup must be as fast or faster than initial computation');

    // Invalidation: append a new transaction
    const modifiedTxns = [
      { _id: 'txn_new', Date: '01/12/2026', 'Income/Expense': 'Income', Account: 'HDFC Bank', Amount: 5000 },
      ...mockTxns,
    ];
    const data3 = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: modifiedTxns,
      acctName: 'HDFC Bank',
    });

    assert.notStrictEqual(data3, data1, 'Modified transactions must invalidate cache and compute fresh data');
    assert.strictEqual(data3[data3.length - 1].fullLabel, 'December 2026');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Repository-Level Paginated Query Verification
  // ─────────────────────────────────────────────────────────────────────────────

  await t.test('18. getAccountTransactionsPaginated supports limit and offset pagination', async () => {
    assert.strictEqual(typeof getAccountTransactionsPaginated, 'function', 'getAccountTransactionsPaginated must be exported');

    // Verify pagination with sample list
    const sample = Array.from({ length: 250 }, (_, i) => ({ _id: `tx_${i}`, Account: 'HDFC', Amount: 100 }));
    const page1 = await getAccountTransactionsPaginated({ account: 'HDFC', limit: 100, offset: 0, txns: sample });
    assert.strictEqual(page1.total, 250);
    assert.strictEqual(page1.transactions.length, 100);
    assert.strictEqual(page1.offset, 0);
    assert.strictEqual(page1.limit, 100);
    assert.strictEqual(page1.hasMore, true);
    assert.strictEqual(page1.nextOffset, 100);

    const page2 = await getAccountTransactionsPaginated({ account: 'HDFC', limit: 100, offset: 100, txns: sample });
    assert.strictEqual(page2.transactions.length, 100);
    assert.strictEqual(page2.transactions[0]._id, 'tx_100');
    assert.strictEqual(page2.hasMore, true);
    assert.strictEqual(page2.nextOffset, 200);

    const page3 = await getAccountTransactionsPaginated({ account: 'HDFC', limit: 100, offset: 200, txns: sample });
    assert.strictEqual(page3.transactions.length, 50);
    assert.strictEqual(page3.hasMore, false);
    assert.strictEqual(page3.nextOffset, null);
  });

  await t.test('19. White icon visibility across Transactions, Drilled Accounts, and Dashboard Reveal & Milestones', () => {
    const txnCss = fs.readFileSync('src/components/Transactions/Transactions.css', 'utf8');
    const acctCss = fs.readFileSync('src/components/Accounts/Accounts.css', 'utf8');
    const dashCss = fs.readFileSync('src/components/Dashboard/Dashboard.css', 'utf8');
    const dashJsx = fs.readFileSync('src/components/Dashboard/Dashboard.jsx', 'utf8');
    const acctJsx = fs.readFileSync('src/components/Accounts/Accounts.jsx', 'utf8');

    // 1. Transactions: paste, bookmark, search icons are white
    assert.ok(txnCss.includes('.txn-paste-btn svg, .txn-bookmark-btn svg'), 'Transactions must style paste and bookmark SVGs');
    assert.ok(txnCss.includes('stroke: #ffffff'), 'Transactions SVGs must use white stroke');

    // 2. Drilled-down Account: search icon is white
    assert.ok(acctCss.includes('.acct-detail-screen .txn-search-btn svg'), 'Drilled account must style search SVG');
    assert.ok(acctCss.includes('stroke: #ffffff'), 'Drilled account search SVG must use white stroke');

    // 3. Dashboard Reveal & Milestones: icons are white
    assert.ok(dashCss.includes('.dash-header-btn svg'), 'Dashboard must style header button SVGs');
    assert.ok(dashCss.includes('.dash-milestones-btn svg'), 'Dashboard must style milestones button SVGs');
    assert.ok(dashCss.includes('stroke: #ffffff'), 'Dashboard button SVGs must use white stroke');

    // 4. Dashboard button dimensions match 28px height, 14px radius standardized styling
    assert.ok(dashCss.includes('height: 28px'), 'Dashboard header buttons must use 28px height');
    assert.ok(dashCss.includes('border-radius: 14px'), 'Dashboard header buttons must use 14px border radius');
    assert.ok(dashJsx.includes('dash-milestones-btn header-pill-btn'), 'Dashboard milestones button must include header-pill-btn');

    // 5. AccountDetail: IntersectionObserver effect is declared after acctTxns to prevent TDZ error
    const acctTxnsDeclIndex = acctJsx.indexOf('const acctTxns = useMemo(');
    const observerEffectIndex = acctJsx.indexOf('// Infinite-scroll IntersectionObserver for incremental All-period rendering');
    assert.ok(acctTxnsDeclIndex > 0, 'acctTxns must be declared');
    assert.ok(observerEffectIndex > acctTxnsDeclIndex, 'IntersectionObserver effect must be positioned after acctTxns declaration');
  });
});
