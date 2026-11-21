import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ValuationProvider } from '../utils/valuationProvider.js';
import { aggregatePositionsForDisplay, getInvestmentDisplayMetrics } from '../utils/portfolioAggregation.js';

test('FinMan — Dashboard and Portfolio Valuation Consistency & FAB Suite', async (t) => {
  // Test fixture representing the exact user scenario:
  // 35 active holdings:
  // - 22 Mutual Funds (20 with valid NAV, 2 without NAV / awaiting sync)
  // - 12 Equity Shares (all 12 valued)
  // - 1 ETF (1 valued)
  // Expected Total: 35 active, 33 valued, 2 held at cost
  const createTestPortfolio = () => {
    const holdings = [];

    // 22 Mutual Funds
    for (let i = 1; i <= 22; i++) {
      const isin = `INF${String(i).padStart(9, '0')}`;
      holdings.push({
        positionKey: `MF_${i}`,
        security: `Mutual Fund Scheme ${i}`,
        investmentAccount: 'Mutual Funds',
        holdingMode: 'PHYSICAL',
        isin,
        status: 'ACTIVE',
        currentUnits: 100 * i,
        remainingCostBasis: 10000 * i,
        ownershipTag: 'PERSONAL'
      });
    }

    // 12 Equity Shares
    for (let i = 1; i <= 12; i++) {
      holdings.push({
        positionKey: `EQ_${i}`,
        security: `Equity Share ${i}`,
        investmentAccount: 'Share Market',
        holdingMode: 'DEMAT',
        isin: `INE${String(i).padStart(9, '0')}`,
        status: 'ACTIVE',
        currentUnits: 10 * i,
        remainingCostBasis: 5000 * i,
        snapshotPrice: 550 * i,
        ownershipTag: 'PERSONAL'
      });
    }

    // 1 ETF
    holdings.push({
      positionKey: 'ETF_1',
      security: 'NIFTYBEES',
      investmentAccount: 'Share Market',
      holdingMode: 'DEMAT',
      isin: 'INF732E01015',
      status: 'ACTIVE',
      currentUnits: 50,
      remainingCostBasis: 12000,
      snapshotPrice: 250,
      ownershipTag: 'PERSONAL'
    });

    return holdings;
  };

  // Create mock provider simulating 20 of 22 MFs having valid NAVs
  const createMockValuationProvider = () => {
    const initialNavMap = {};
    // 20 mutual funds have live NAV
    for (let i = 1; i <= 20; i++) {
      const isin = `INF${String(i).padStart(9, '0')}`;
      initialNavMap[isin] = 120 + i;
    }
    // MF 21 and MF 22 have no NAV (unvalued)

    return new ValuationProvider(initialNavMap);
  };

  await t.test('1. Dashboard and Portfolio calculate identical valuation coverage for same fixture', () => {
    const holdings = createTestPortfolio();
    const provider = createMockValuationProvider();

    // Portfolio screen calculation logic
    let portfolioValuedCount = 0;
    let portfolioTotalValuedAmount = 0;
    let portfolioCostBasis = 0;

    for (const p of holdings) {
      portfolioCostBasis += (p.remainingCostBasis || 0);
      const v = provider.getValuation(p);
      if (v && v.isValued && typeof v.currentValue === 'number') {
        portfolioValuedCount++;
        portfolioTotalValuedAmount += v.currentValue;
      }
    }

    // Dashboard Investment Summary calculation logic
    const eq = { count: 0, cost: 0, value: 0, valuedCount: 0 };
    const mf = { count: 0, cost: 0, value: 0, valuedCount: 0 };

    for (const p of holdings) {
      const meta = getInvestmentDisplayMetrics(p);
      const isMF = meta.assetType === 'MUTUAL_FUND';
      const cost = p.remainingCostBasis || 0;
      const v = provider.getValuation(p);
      const isVal = !!(v && v.isValued && typeof v.currentValue === 'number');
      const val = isVal ? v.currentValue : 0;

      if (isMF) {
        mf.count++;
        mf.cost += cost;
        mf.value += val;
        if (isVal) mf.valuedCount++;
      } else {
        eq.count++;
        eq.cost += cost;
        eq.value += val;
        if (isVal) eq.valuedCount++;
      }
    }

    const dashboardValuedCount = eq.valuedCount + mf.valuedCount;
    const dashboardTotalValuedAmount = eq.value + mf.value;

    assert.equal(holdings.length, 35, 'Total active holdings must be exactly 35');
    assert.equal(portfolioValuedCount, 33, 'Portfolio must report 33 valued holdings');
    assert.equal(dashboardValuedCount, 33, 'Dashboard must report 33 valued holdings');
    assert.equal(portfolioValuedCount, dashboardValuedCount, 'Dashboard and Portfolio must match valued counts');
    assert.equal(Math.round(portfolioTotalValuedAmount * 100) / 100, Math.round(dashboardTotalValuedAmount * 100) / 100, 'Total valued amounts must match');

    // Asset breakdown checks
    assert.equal(mf.count, 22, 'Mutual funds count must be 22');
    assert.equal(mf.valuedCount, 20, 'Mutual funds valued count must be 20');
    assert.equal(eq.count, 13, 'Stocks & ETF count must be 13');
    assert.equal(eq.valuedCount, 13, 'Stocks & ETF valued count must be 13');
  });

  await t.test('2. Mutual funds with valid NAV data count as valued; without NAV remain unvalued', () => {
    const holdings = createTestPortfolio();
    const provider = createMockValuationProvider();

    // MF 1 to 20 should be valued
    for (let i = 1; i <= 20; i++) {
      const p = holdings.find(h => h.positionKey === `MF_${i}`);
      const val = provider.getValuation(p);
      assert.equal(val.isValued, true, `MF_${i} with NAV must be marked isValued: true`);
      assert.ok(val.currentValue > 0, `MF_${i} must have positive currentValue`);
      assert.equal(val.nav, 120 + i, `MF_${i} NAV must match mock rate`);
    }

    // MF 21 and MF 22 should NOT be valued
    for (let i = 21; i <= 22; i++) {
      const p = holdings.find(h => h.positionKey === `MF_${i}`);
      const val = provider.getValuation(p);
      assert.equal(val.isValued, false, `MF_${i} without NAV must have isValued: false`);
      assert.equal(val.currentValue, null, `MF_${i} without NAV must have null currentValue`);
      assert.equal(val.nav, null, `MF_${i} without NAV must have null NAV`);
    }
  });

  await t.test('3. Equity and ETF holdings are counted and valued correctly', () => {
    const holdings = createTestPortfolio();
    const provider = createMockValuationProvider();

    // 12 Equities
    for (let i = 1; i <= 12; i++) {
      const p = holdings.find(h => h.positionKey === `EQ_${i}`);
      const meta = getInvestmentDisplayMetrics(p);
      assert.equal(meta.assetType, 'EQUITY');
      const val = provider.getValuation(p);
      assert.equal(val.isValued, true);
      assert.equal(val.currentValue, p.currentUnits * p.snapshotPrice);
    }

    // 1 ETF
    const etf = holdings.find(h => h.positionKey === 'ETF_1');
    const meta = getInvestmentDisplayMetrics(etf);
    assert.equal(meta.assetType, 'ETF');
    const val = provider.getValuation(etf);
    assert.equal(val.isValued, true);
    assert.equal(val.currentValue, 50 * 250);
  });

  await t.test('4. Missing valuation data is not converted into zero or a fabricated value', () => {
    const provider = createMockValuationProvider();
    const unvaluedPos = {
      positionKey: 'UNVALUED_TEST',
      security: 'Unknown Fund',
      investmentAccount: 'Mutual Funds',
      currentUnits: 500,
      remainingCostBasis: 50000
    };

    const val = provider.getValuation(unvaluedPos);
    assert.equal(val.isValued, false);
    assert.equal(val.currentValue, null, 'Unvalued holding must have null currentValue, NEVER 0');
    assert.equal(val.nav, null, 'Unvalued holding must have null nav, NEVER 0');
    assert.equal(val.unrealizedPnl, null, 'Unvalued holding must have null unrealizedPnl');
  });

  await t.test('5. ValuationProvider pub/sub notifies listeners when valuations update', () => {
    const provider = new ValuationProvider();
    let notified = false;

    const unsubscribe = provider.subscribe(() => {
      notified = true;
    });

    provider.notifyListeners();
    assert.equal(notified, true, 'Subscriber must be notified on update');

    // Test unsubscribe
    notified = false;
    unsubscribe();
    provider.notifyListeners();
    assert.equal(notified, false, 'Unsubscribed listener must not be called');
  });

  await t.test('6. Dashboard Investment Summary uses authoritative hook with autoFetchValuations: true', () => {
    const summaryCode = fs.readFileSync('src/components/Dashboard/DashboardInvestmentSummary.jsx', 'utf8');

    assert.ok(summaryCode.includes('autoFetchValuations: true'), 'DashboardInvestmentSummary must use autoFetchValuations: true');
    assert.ok(summaryCode.includes('isFetchingValuations'), 'DashboardInvestmentSummary must consume isFetchingValuations');
    assert.ok(summaryCode.includes('Syncing NAVs...'), 'DashboardInvestmentSummary must display syncing state while loading');
  });

  await t.test('7. Floating action button group layout and sidebar independence', () => {
    const dashJsx = fs.readFileSync('src/components/Dashboard/Dashboard.jsx', 'utf8');
    const txnJsx = fs.readFileSync('src/components/Transactions/Transactions.jsx', 'utf8');
    const dashCss = fs.readFileSync('src/components/Dashboard/Dashboard.css', 'utf8');
    const globalsCss = fs.readFileSync('src/styles/globals.css', 'utf8');

    // Both screens render screen-fab-group with trans-fab and bookmarks-fab
    assert.ok(dashJsx.includes('screen-fab-group'), 'Dashboard must render screen-fab-group');
    assert.ok(dashJsx.includes('bookmarks-fab'), 'Dashboard must render bookmarks-fab');
    assert.ok(dashJsx.includes('aria-label="Add transaction"'), 'Dashboard FAB must have accessible label');
    assert.ok(dashJsx.includes('aria-label="Bookmarks"'), 'Dashboard bookmarks FAB must have accessible label');

    assert.ok(txnJsx.includes('screen-fab-group'), 'Transactions must render screen-fab-group');
    assert.ok(txnJsx.includes('bookmarks-fab'), 'Transactions must render bookmarks-fab');
    assert.ok(txnJsx.includes('aria-label="Add transaction"'), 'Transactions FAB must have accessible label');
    assert.ok(txnJsx.includes('aria-label="Bookmarks"'), 'Transactions bookmarks FAB must have accessible label');

    // globals.css defines shared screen-fab-group positioned absolutely inside screen container
    assert.ok(globalsCss.includes('.screen-fab-group {'), 'globals.css must define .screen-fab-group');
    assert.ok(globalsCss.includes('position: absolute;'), 'screen-fab-group must be position: absolute inside screen container');
    assert.ok(globalsCss.includes('.screen-fab-group .bookmarks-fab'), 'globals.css must style bookmarks-fab');

    // Dashboard.css has no conflicting position: fixed on trans-fab
    assert.ok(!dashCss.includes('position: fixed; right: calc(var(--page-px) + 6px);'), 'Dashboard.css must not have conflicting position: fixed on trans-fab');
    assert.ok(dashCss.includes('.dash-screen {'), 'Dashboard.css must define .dash-screen');
    assert.ok(!dashCss.includes('min-height: 100vh;'), 'Dashboard.css must not force 100vh on .dash-screen');
  });
});

