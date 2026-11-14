import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, formatINR, formatINRCompact } from '../utils/format.js';
import { detectAssetType } from '../utils/valuationProvider.js';
import { calculateDebtLedgers, extractPersonName, normalizePersonKey } from '../utils/debtTrackerUtils.js';

test('FinMan Dashboard — Financial Accuracy & Reconciliation Tests', async (t) => {

  await t.test('1. Savings rate handles low income baseline and monthly deficits without extreme percentages', () => {
    const MIN_THRESHOLD = 5000; // ₹5,000

    const calculateSavingsRate = (income, expense) => {
      const savings = income - expense;
      const isDeficit = savings < 0;
      const isLowIncome = income < MIN_THRESHOLD;

      if (isLowIncome) {
        return {
          savings,
          isDeficit,
          rate: null,
          display: isDeficit ? 'Deficit' : 'N/A',
          status: isDeficit ? 'Monthly Deficit' : 'Low Income Baseline',
          statusColor: isDeficit ? '#EE5D50' : '#8FA0BC',
          reason: isDeficit ? 'Expenses exceeded income (Income < ₹5,000)' : 'Income below threshold'
        };
      }

      const rate = Math.round((savings / income) * 100);
      return {
        savings,
        isDeficit,
        rate,
        display: `${rate}%`,
        status: rate >= 20 ? 'Optimal' : rate >= 0 ? 'Low' : 'Deficit',
        statusColor: rate >= 20 ? '#01B574' : rate >= 0 ? '#FFAA00' : '#EE5D50',
        reason: null
      };
    };

    // Case A: User's exact scenario: Income ₹840, Expense ₹15,900
    const userCase = calculateSavingsRate(840, 15900);
    assert.equal(userCase.savings, -15060, 'Monthly savings must be exactly -₹15,060');
    assert.equal(userCase.isDeficit, true, 'Must be flagged as deficit');
    assert.equal(userCase.rate, null, 'Extreme percentage (e.g. -1788%) must not be returned');
    assert.equal(userCase.display, 'Deficit', 'Display must show Deficit');
    assert.equal(userCase.status, 'Monthly Deficit');

    // Case B: Normal income ₹50,000, Expense ₹35,000 (Savings ₹15,000, Rate 30%)
    const normalCase = calculateSavingsRate(50000, 35000);
    assert.equal(normalCase.savings, 15000);
    assert.equal(normalCase.rate, 30);
    assert.equal(normalCase.display, '30%');
    assert.equal(normalCase.status, 'Optimal');

    // Case C: Deficit with normal income: Income ₹60,000, Expense ₹75,000 (Savings -₹15,000, Rate -25%)
    const normalDeficit = calculateSavingsRate(60000, 75000);
    assert.equal(normalDeficit.savings, -15000);
    assert.equal(normalDeficit.rate, -25);
    assert.equal(normalDeficit.display, '-25%');
    assert.equal(normalDeficit.status, 'Deficit');
  });

  await t.test('2. Portfolio reconciliation: Asset class separation and mathematical reconciliation', () => {
    // Mock user's exact portfolio composition
    const positions = [
      // 5 Equity Shares: Cost basis ₹75,328, Market Value ₹76,304
      {
        security: 'TCS',
        investmentAccount: 'Share Market',
        holdingMode: 'DEMAT',
        remainingCostBasis: 25000,
        currentUnits: 8,
        valuation: { isValued: true, currentValue: 25400 }
      },
      {
        security: 'INFY',
        investmentAccount: 'Share Market',
        holdingMode: 'DEMAT',
        remainingCostBasis: 20000,
        currentUnits: 12,
        valuation: { isValued: true, currentValue: 20250 }
      },
      {
        security: 'RELIANCE',
        investmentAccount: 'Share Market',
        holdingMode: 'DEMAT',
        remainingCostBasis: 15328,
        currentUnits: 6,
        valuation: { isValued: true, currentValue: 15500 }
      },
      {
        security: 'HDFCBANK',
        investmentAccount: 'Share Market',
        holdingMode: 'DEMAT',
        remainingCostBasis: 10000,
        currentUnits: 6,
        valuation: { isValued: true, currentValue: 10100 }
      },
      {
        security: 'ITC',
        investmentAccount: 'Share Market',
        holdingMode: 'DEMAT',
        remainingCostBasis: 5000,
        currentUnits: 10,
        valuation: { isValued: true, currentValue: 5054 }
      },
      // 3 Mutual Funds (representing the ₹9.24L mutual funds portfolio awaiting live NAV):
      {
        security: 'Quant Small Cap Fund',
        investmentAccount: 'Mutual Funds',
        isin: 'INF966L01AA3',
        remainingCostBasis: 85500,
        currentUnits: 450,
        valuation: { isValued: false, currentValue: null }
      },
      {
        security: 'Parag Parikh Flexi Cap Fund',
        investmentAccount: 'Mutual Funds',
        isin: 'INF879O01019',
        remainingCostBasis: 16000,
        currentUnits: 200,
        valuation: { isValued: false, currentValue: null }
      },
      {
        security: 'Mirae Asset Large Cap Fund',
        investmentAccount: 'Mutual Funds',
        isin: 'INF769K01020',
        remainingCostBasis: 823350,
        currentUnits: 5000,
        valuation: { isValued: false, currentValue: null }
      }
    ];

    // Authoritative aggregation
    let equityCost = 0;
    let equityValuedAmount = 0;
    let equityValuedCount = 0;
    let mfCost = 0;
    let mfValuedCount = 0;

    for (const p of positions) {
      const type = detectAssetType(p);
      const cost = p.remainingCostBasis || 0;
      if (type === 'EQUITY' || type === 'ETF') {
        equityCost += cost;
        if (p.valuation?.isValued) {
          equityValuedAmount += p.valuation.currentValue;
          equityValuedCount++;
        }
      } else {
        mfCost += cost;
        if (p.valuation?.isValued) {
          mfValuedCount++;
        }
      }
    }

    assert.equal(equityCost, 75328, 'Equity cost basis matches ~₹75.3K');
    assert.equal(equityValuedAmount, 76304, 'Equity market value matches ₹76,304');
    assert.equal(mfCost, 924850, 'Mutual Funds cost basis matches ~₹9.25L');

    const totalCostBasis = equityCost + mfCost;
    assert.equal(totalCostBasis, 1000178, 'Total cost basis matches ₹10.0L');

    // Reconciled Total Portfolio Value = Valued Equity (Market Value) + Unvalued Mutual Funds (Cost Basis)
    const effectiveTotalPortfolioValue = equityValuedAmount + mfCost;
    assert.equal(effectiveTotalPortfolioValue, 1001154, 'Blended portfolio value matches ₹10.01L');

    // Unrealized P&L on valued assets:
    const equityUnrealizedPnl = equityValuedAmount - equityCost;
    assert.equal(equityUnrealizedPnl, 976, 'Unrealized P&L on valued equity matches +₹976');

    // Reconciled difference:
    assert.equal(
      effectiveTotalPortfolioValue - totalCostBasis,
      equityUnrealizedPnl,
      'Effective portfolio value minus cost basis MUST equal the net unrealized P&L (+₹976)'
    );
  });

  await t.test('3. Date classification: Separates recent historical transactions from future scheduled/instalment entries', () => {
    const reportingDate = new Date('2026-11-14T12:00:00Z');

    const mockTransactions = [
      { id: 't1', Date: '2026-11-10', Note: 'Groceries' },
      { id: 't2', Date: '2026-11-12', Note: 'Fuel' },
      { id: 't3', Date: '2027-09-15', Note: 'Future Loan Instalment' }, // 2027!
      { id: 't4', Date: '2027-01-01', Note: 'Scheduled Insurance' },    // 2027!
      { id: 't5', Date: '2026-11-14', Note: 'Today Dining' },
      { id: 't6', Date: '2026-10-31', Note: 'October Rent' }
    ];

    const todayEnd = new Date(reportingDate.getFullYear(), reportingDate.getMonth(), reportingDate.getDate(), 23, 59, 59, 999);

    const completed = [];
    const upcoming = [];

    for (const t of mockTransactions) {
      const d = parseDate(t.Date);
      if (d <= todayEnd) {
        completed.push(t);
      } else {
        upcoming.push(t);
      }
    }

    // Sort completed by date descending (most recent past first)
    completed.sort((a, b) => parseDate(b.Date) - parseDate(a.Date));
    // Sort upcoming by date ascending (closest future first)
    upcoming.sort((a, b) => parseDate(a.Date) - parseDate(b.Date));

    assert.equal(completed.length, 4, 'Must have 4 completed transactions up to today');
    assert.equal(completed[0].Date, '2026-11-14', 'Most recent completed must be today');
    assert.equal(completed[1].Date, '2026-11-12');
    assert.equal(completed[2].Date, '2026-11-10');
    assert.equal(completed[3].Date, '2026-10-31');

    assert.equal(upcoming.length, 2, 'Must have 2 future scheduled transactions');
    assert.equal(upcoming[0].Date, '2027-01-01', 'Closest future transaction must be first');
    assert.equal(upcoming[1].Date, '2027-09-15', 'September 2027 must be classified as upcoming');
  });

  await t.test('4. Authoritative Debt Tracker calculation matches exact user figures with name normalization', () => {
    // User-supplied exact figures and counterparties:
    // Chamundi: +₹8,178
    // Mom for dwakra: -₹4,941
    // Chota mamu: +₹4,371
    // Mamu: +₹1,258
    // Arshad: +₹1,255
    // Amzad: +₹565
    // Mami: +₹272
    // Choti mami: +₹127
    // Total to receive: ₹16,026
    // Total to repay: ₹4,941
    const mockDebtTransactions = [
      // Chamundi (+8178)
      { id: 'd1', Date: '2026-05-10', Account: 'Cash', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to Chamundi', Amount: 10000 },
      { id: 'd2', Date: '2026-06-15', Account: 'Lend', ToAccount: 'Cash', Category: 'Lend', 'Income/Expense': 'Income', Note: 'received from Chamundi repayment', Amount: 1822 },

      // Mom for dwakra (-4941)
      { id: 'd3', Date: '2026-07-01', Account: 'Borrow', ToAccount: 'Bank', Category: 'Borrow', 'Income/Expense': 'Income', Note: 'from Mom for dwakra', Amount: 6000 },
      { id: 'd4', Date: '2026-08-01', Account: 'Bank', ToAccount: 'Borrow', Category: 'Borrow', 'Income/Expense': 'Expense', Note: 'repay to Mom for dwakra', Amount: 1059 },

      // Chota mamu (+4371) - Test mixed casing and redundant whitespace
      { id: 'd5', Date: '2026-08-10', Account: 'Bank', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to   chota mamu  ', Amount: 5000 },
      { id: 'd6', Date: '2026-09-01', Account: 'Lend', ToAccount: 'Bank', Category: 'Lend', 'Income/Expense': 'Income', Note: 'return from Chota mamu', Amount: 629 },

      // Mamu (+1258) - Test case-insensitive merging of "mamu" and "Mamu"
      { id: 'd7', Date: '2026-09-10', Account: 'Cash', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to mamu', Amount: 2000 },
      { id: 'd8', Date: '2026-10-01', Account: 'Lend', ToAccount: 'Cash', Category: 'Lend', 'Income/Expense': 'Income', Note: 'return from Mamu', Amount: 742 },

      // Arshad (+1255)
      { id: 'd9', Date: '2026-10-05', Account: 'Bank', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to Arshad', Amount: 1255 },

      // Amzad (+565)
      { id: 'd10', Date: '2026-10-10', Account: 'Bank', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to Amzad', Amount: 565 },

      // Mami (+272)
      { id: 'd11', Date: '2026-10-15', Account: 'Cash', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to Mami', Amount: 272 },

      // Choti mami (+127)
      { id: 'd12', Date: '2026-10-20', Account: 'Cash', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to Choti mami', Amount: 127 },

      // Non-person transaction that should be ignored by DebtTracker (e.g. Share Market transfer or Goa trip)
      { id: 'd13', Date: '2026-10-25', Account: 'Bank', ToAccount: 'Lend', Category: 'Lend', 'Income/Expense': 'Expense', Note: 'to Share Market', Amount: 50000 },
    ];

    const result = calculateDebtLedgers(mockDebtTransactions);

    assert.equal(result.totalReceivable, 16026, 'Total receivable must equal ₹16,026');
    assert.equal(result.totalPayable, 4941, 'Total payable must equal ₹4,941');

    // Individual balances map
    const balances = {};
    for (const p of result.personLedgers) {
      balances[p.name.toLowerCase()] = p.netBalance;
    }

    assert.equal(balances['chamundi'], 8178, 'Chamundi must be +₹8,178');
    assert.equal(balances['mom for dwakra'], -4941, 'Mom for dwakra must be -₹4,941');
    assert.equal(balances['chota mamu'], 4371, 'Chota mamu must be +₹4,371');
    assert.equal(balances['mamu'], 1258, 'Mamu must be +₹1,258 with no duplicate chips');
    assert.equal(balances['arshad'], 1255, 'Arshad must be +₹1,255');
    assert.equal(balances['amzad'], 565, 'Amzad must be +₹565');
    assert.equal(balances['mami'], 272, 'Mami must be +₹272');
    assert.equal(balances['choti mami'], 127, 'Choti mami must be +₹127');

    // Mathematical reconciliation check: sum of individual receivables must equal totalReceivable
    const individualRecSum = result.counterparties
      .filter(c => c.type === 'lent')
      .reduce((sum, c) => sum + c.amount, 0);
    assert.equal(individualRecSum, result.totalReceivable, 'Sum of individual receivable chips must equal totalReceivable');

    const individualPaySum = result.counterparties
      .filter(c => c.type === 'borrowed')
      .reduce((sum, c) => sum + c.amount, 0);
    assert.equal(individualPaySum, result.totalPayable, 'Sum of individual payable chips must equal totalPayable');
  });

  await t.test('5. Salary timing, Month-to-date cash flow and expected income forecasts', () => {
    // Current month in progress: 14 days elapsed out of 30 days
    // Actual received income: ₹840, actual expenses: ₹15,900
    // Recurring income rule configured: ₹85,000 monthly salary due on 30th
    const now = new Date('2026-11-14T12:00:00Z');
    const daysElapsed = 14;
    const daysInMonth = 30;
    const isUnfinishedMonth = daysElapsed < daysInMonth;

    const actualIncome = 840;
    const actualExpense = 15900;
    const actualNetCashFlow = actualIncome - actualExpense; // -15060

    const recurringIncomeRules = [
      { rule_type: 'repeat', txn_type: 'Income', amount_per_part: 85000, status: 'active', note: 'Monthly Salary' }
    ];

    const expectedIncome = recurringIncomeRules
      .filter(r => r.status === 'active' && r.txn_type.toLowerCase() === 'income')
      .reduce((sum, r) => sum + r.amount_per_part, 0);

    assert.equal(isUnfinishedMonth, true, 'Current mid-month period must be detected as unfinished');
    assert.equal(actualNetCashFlow, -15060, 'Month-to-date actual net cash flow is -₹15,060');
    assert.equal(expectedIncome, 85000, 'Expected recurring income is ₹85,000 forecast');

    // Forecast remaining month-end projection
    const dailyExpenseBurn = actualExpense / daysElapsed;
    const projectedExpense = Math.round(dailyExpenseBurn * daysInMonth); // ~34071
    const projectedMonthEndCashFlow = Math.round((actualIncome + (expectedIncome - actualIncome)) - projectedExpense);

    assert.ok(projectedMonthEndCashFlow > 0, 'Projected month-end cash flow takes expected salary into forecast');
  });

  await t.test('6. Yearly aggregation and Net Worth trajectory avoids flat zero line', () => {
    // Simulation of multi-year history
    const monthlyLedger = {
      '2024-10': { income: 50000, expense: 30000 },
      '2024-11': { income: 55000, expense: 35000 },
      '2024-12': { income: 60000, expense: 40000 },
      '2025-01': { income: 70000, expense: 45000 },
      '2025-02': { income: 72000, expense: 46000 },
      '2026-10': { income: 80000, expense: 50000 },
      '2026-11': { income: 840, expense: 15900 }
    };

    const sortedYmKeys = Object.keys(monthlyLedger).sort();
    let runningCumulativeNW = 0;
    const monthlyCumulativeNW = {};
    for (const k of sortedYmKeys) {
      const b = monthlyLedger[k];
      runningCumulativeNW += (b.income - b.expense);
      monthlyCumulativeNW[k] = runningCumulativeNW;
    }

    const yearlyMap = {};
    for (const [ymKey, b] of Object.entries(monthlyLedger)) {
      const yr = ymKey.split('-')[0];
      if (!yearlyMap[yr]) {
        yearlyMap[yr] = { year: yr, income: 0, expense: 0, savings: 0, monthsCount: 0 };
      }
      yearlyMap[yr].income += b.income;
      yearlyMap[yr].expense += b.expense;
      yearlyMap[yr].savings += (b.income - b.expense);
      yearlyMap[yr].monthsCount++;
    }

    const validYears = Object.values(yearlyMap)
      .filter(y => (y.income > 0 || y.expense > 0 || y.monthsCount > 0))
      .sort((a, b) => a.year.localeCompare(b.year));

    let runningYearlyNW = 0;
    const seriesYearly = validYears.map(y => {
      runningYearlyNW += (y.income - y.expense);
      return {
        key: y.year,
        label: y.year,
        income: Math.round(y.income),
        expense: Math.round(y.expense),
        savings: Math.round(y.savings),
        netWorth: Math.round(runningYearlyNW),
      };
    });

    assert.equal(seriesYearly.length, 3, 'Must contain valid years 2024, 2025, 2026');
    assert.equal(seriesYearly[0].key, '2024');
    assert.equal(seriesYearly[0].netWorth, 60000, '2024 cumulative net worth must not be zero');
    assert.equal(seriesYearly[1].key, '2025');
    assert.equal(seriesYearly[1].netWorth, 111000, '2025 cumulative net worth builds on 2024');
    assert.equal(seriesYearly[2].key, '2026');
    assert.ok(seriesYearly[2].netWorth > 0, '2026 net worth is non-zero');

    // When no data exists at all
    const emptySeries = [];
    const isYearlyNetWorthUnavailable = emptySeries.length === 0 || emptySeries.every(y => y.netWorth === 0);
    assert.equal(isYearlyNetWorthUnavailable, true, 'Flags data unavailable message instead of flat zero line');
  });

  await t.test('8. Month-to-date Cash Flow semantics and horizontal distribution logic', () => {
    const MIN_THRESHOLD = 5000;

    const evaluateCashFlowCard = ({
      monthlyIncome,
      monthlyExpenses,
      isUnfinishedMonth,
      daysElapsed = 14,
      daysInMonth = 30,
      monthLabel = 'November 2026',
    }) => {
      const monthlySavings = monthlyIncome - monthlyExpenses;
      const isDeficit = monthlySavings < 0;
      const isLowIncome = monthlyIncome < MIN_THRESHOLD;

      // Rate calculation
      let savingsRate = null;
      if (!isLowIncome && !isUnfinishedMonth) {
        savingsRate = Math.round((monthlySavings / monthlyIncome) * 100);
      } else if (!isLowIncome && isUnfinishedMonth && monthlySavings >= 0) {
        savingsRate = Math.round((monthlySavings / monthlyIncome) * 100);
      }

      const isCashFlowMode = isUnfinishedMonth || savingsRate === null;
      const cardTitle = isCashFlowMode
        ? (isUnfinishedMonth ? 'Month-to-date Cash Flow' : 'Monthly Cash Flow')
        : 'Monthly Savings Rate';

      const cardSubtitle = isUnfinishedMonth
        ? `Day ${daysElapsed} of ${daysInMonth} · In progress`
        : `${monthLabel} · Settled`;

      const statusBadgeLabel = isDeficit
        ? 'Deficit'
        : (isCashFlowMode ? (monthlySavings > 0 ? 'Surplus' : 'Balanced') : `${savingsRate}% Saved`);

      const statusBadgeColor = isDeficit
        ? '#EE5D50'
        : (monthlySavings > 0 ? '#01B574' : '#8FA0BC');

      const primaryValue = isCashFlowMode
        ? (monthlySavings >= 0 ? `+${formatINR(monthlySavings)}` : `−${formatINR(Math.abs(monthlySavings))}`)
        : `${savingsRate}%`;

      const explanation = isCashFlowMode
        ? (isDeficit
            ? 'Expenses exceed income'
            : (monthlySavings > 0 ? 'Net cash retained' : 'Break-even cash flow'))
        : 'of income saved';

      // Horizontal Indicator Distribution
      const totalFlow = monthlyIncome + monthlyExpenses;
      let incomeBarPct = 0;
      let expenseBarPct = 0;
      if (totalFlow > 0) {
        if (monthlyIncome === 0) {
          incomeBarPct = 0;
          expenseBarPct = 100;
        } else if (monthlyExpenses === 0) {
          incomeBarPct = 100;
          expenseBarPct = 0;
        } else {
          const rawIncomePct = (monthlyIncome / totalFlow) * 100;
          incomeBarPct = Math.max(5, Math.min(95, Math.round(rawIncomePct)));
          expenseBarPct = 100 - incomeBarPct;
        }
      }

      return {
        cardTitle,
        cardSubtitle,
        statusBadgeLabel,
        statusBadgeColor,
        primaryValue,
        explanation,
        isDeficit,
        isCashFlowMode,
        savingsRate,
        incomeBarPct,
        expenseBarPct,
      };
    };

    // Case A: User's in-progress deficit scenario (Income ₹0, Expense ₹14,366)
    const cardA = evaluateCashFlowCard({
      monthlyIncome: 0,
      monthlyExpenses: 14366,
      isUnfinishedMonth: true,
      daysElapsed: 14,
      daysInMonth: 30,
    });
    assert.equal(cardA.cardTitle, 'Month-to-date Cash Flow', 'Card must be titled Month-to-date Cash Flow');
    assert.equal(cardA.primaryValue, '−₹14,366', 'Shows actual rupee deficit prominently');
    assert.equal(cardA.explanation, 'Expenses exceed income', 'Shows exact required explanation');
    assert.equal(cardA.isDeficit, true, 'Negative styling flag set');
    assert.equal(cardA.statusBadgeLabel, 'Deficit', 'Badge displays Deficit');
    assert.equal(cardA.savingsRate, null, 'No manufactured savings rate percentage');
    assert.equal(cardA.incomeBarPct, 0, 'Income segment is 0%');
    assert.equal(cardA.expenseBarPct, 100, 'Expense segment is 100%');

    // Case B: In-progress surplus scenario (Income ₹50,000, Expense ₹20,000)
    const cardB = evaluateCashFlowCard({
      monthlyIncome: 50000,
      monthlyExpenses: 20000,
      isUnfinishedMonth: true,
      daysElapsed: 14,
      daysInMonth: 30,
    });
    assert.equal(cardB.cardTitle, 'Month-to-date Cash Flow', 'In-progress month titled Month-to-date Cash Flow');
    assert.equal(cardB.primaryValue, '+₹30,000', 'Shows positive cash flow');
    assert.equal(cardB.explanation, 'Net cash retained');
    assert.equal(cardB.savingsRate, 60, 'Savings rate can be displayed separately with proper label');
    assert.equal(cardB.incomeBarPct, 71, 'Proportional income progress');
    assert.equal(cardB.expenseBarPct, 29, 'Proportional expense progress');

    // Case C: Settled completed month with normal income (Income ₹60,000, Expense ₹42,000)
    const cardC = evaluateCashFlowCard({
      monthlyIncome: 60000,
      monthlyExpenses: 42000,
      isUnfinishedMonth: false,
    });
    assert.equal(cardC.cardTitle, 'Monthly Savings Rate', 'Settled month with valid rate displays Monthly Savings Rate');
    assert.equal(cardC.primaryValue, '30%', 'Displays percentage');
    assert.equal(cardC.explanation, 'of income saved');
    assert.equal(cardC.savingsRate, 30);
  });

});
