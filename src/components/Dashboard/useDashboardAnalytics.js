import { useMemo } from 'react';
import { parseDate, txnType, txnAmount, isLifestyleExpense } from '../../utils/format.js';
import { calculateDebtLedgers } from '../../utils/debtTrackerUtils.js';
import { ccBalances, isCreditCard, ccDaysUntilDue, ccNextDueDate } from '../Accounts/Accounts.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const INVESTMENT_KEYWORDS = ['stock', 'mutual fund', 'ppf', 'ssy', 'equity', 'share market', 'investment', 'recurring deposit'];

// Minimum income threshold to calculate a statistically meaningful savings rate.
// When monthly income is below this threshold, extreme percentages (e.g. -1788%) are misleading.
export const MIN_SAVINGS_RATE_INCOME_THRESHOLD = 5000;

export const isInvestment = (name) => {
  const n = String(name || '').toLowerCase();
  const hasWordRD = /\brd\b/i.test(n);
  return INVESTMENT_KEYWORDS.some(kw => n.includes(kw)) || hasWordRD;
};

export function useDashboardAnalytics({ transactions = [], accounts = [], budgets = [], recurringRules = [], settings = {} }) {
  const now = useMemo(() => new Date(), []);

  return useMemo(() => {
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const daysElapsed = Math.max(1, now.getDate());

    const thisMonthStart = new Date(currentYear, currentMonth, 1);
    const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
    const todayEnd = new Date(currentYear, currentMonth, now.getDate(), 23, 59, 59, 999);

    // ── 1. ACCOUNT BALANCES & NET WORTH ──────────────────────────────────────────
    const acctBalances = {};
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
    const ensure = n => { if (n && !looksNumeric(n) && !acctBalances[n]) acctBalances[n] = 0; };
    const addTo = (n, v) => { if (n && !looksNumeric(n)) { ensure(n); acctBalances[n] = (acctBalances[n] || 0) + v; } };

    // Categorized monthly buckets for fast time-series
    const monthlyLedger = {}; // key: "YYYY-MM" => { income, expense, savings, txns: [] }
    const categoryMonthMap = {}; // key: "YYYY-MM" => { [cat]: number }
    let monthlyInvested = 0;
    let totalInvested = 0;
// Partition transactions into completed past and future scheduled
    const completedTransactions = [];
    const futureTransactions = [];

    for (let i = 0; i < transactions.length; i++) {
      const t = transactions[i];
      const amt = txnAmount(t);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = String(t.Account || '').trim();
      const fromAcct = String(t.FromAccount || t.Account || '').trim();
      const dest = String(t.ToAccount || '').trim();
      const cat = String(t.Category || '').trim();
      const rawNote = String(t.Note || t.Description || '').trim();
      const d = parseDate(t.Date);
      const isDateValid = !isNaN(d.getTime());

      if (isDateValid) {
        if (d.getTime() <= todayEnd.getTime()) {
          completedTransactions.push(t);
        } else {
          futureTransactions.push(t);
        }
      }

      // Account Balance update
      if (type === 'Income') {
        addTo(dest || acct, +amt);
      } else if (type === 'Expense') {
        addTo(fromAcct || acct, -amt);
      } else if (type === 'Transfer-Out') {
        addTo(fromAcct, -amt);
        addTo(dest, +amt);
      }

      // Investment tracking
      const isXfer = type.toLowerCase().startsWith('transfer');
      const isInv = isInvestment(cat) || (isXfer && isInvestment(dest)) || isInvestment(acct);
      if (isInv) {
        totalInvested += amt;
        if (isDateValid && d.getFullYear() === currentYear && d.getMonth() === currentMonth) {
          monthlyInvested += amt;
        }
      }

      // Time-series aggregation (only historical / up to current month)
      if (isDateValid && d.getTime() <= todayEnd.getTime()) {
        const ymKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyLedger[ymKey]) {
          monthlyLedger[ymKey] = {
            year: d.getFullYear(),
            month: d.getMonth(),
            income: 0,
            expense: 0,
            txnsCount: 0,
          };
        }
        const b = monthlyLedger[ymKey];
        b.txnsCount++;
        if (type === 'Income') {
          b.income += amt;
        } else if (type === 'Expense') {
          b.expense += amt;
          if (!categoryMonthMap[ymKey]) categoryMonthMap[ymKey] = {};
          categoryMonthMap[ymKey][cat || 'Others'] = (categoryMonthMap[ymKey][cat || 'Others'] || 0) + amt;
        }
      }
}

    // Net worth, assets, and liabilities
    const netWorth = Object.values(acctBalances).reduce((s, v) => s + v, 0);

    let assets = 0;
    let liabilities = 0;
    let liquidAssets = 0;

    for (const [name, val] of Object.entries(acctBalances)) {
      const a = accounts.find(acc => (acc.name || acc) === name);
      const isLiability = !a?.isAsset && ['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => name.toLowerCase().includes(k));

      if (isLiability) {
        liabilities += Math.abs(val);
      } else {
        if (val > 0) {
          assets += val;
          if (!isInvestment(name)) {
            liquidAssets += val;
          }
        } else if (val < 0) {
          // Overdraft on bank account
          liabilities += Math.abs(val);
        }
      }
    }

    // ── 2. CURRENT MONTH & LAST MONTH TOTALS ────────────────────────────────────
    const currentYmKey = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
    const lastYmKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

    const thisMonthBucket = monthlyLedger[currentYmKey] || { income: 0, expense: 0 };
    const lastMonthBucket = monthlyLedger[lastYmKey] || { income: 0, expense: 0 };

    const thisMonthIncome = thisMonthBucket.income;
    const thisMonthExpense = thisMonthBucket.expense;
    const thisMonthSavings = thisMonthIncome - thisMonthExpense;
    const isDeficit = thisMonthSavings < 0;
    const isLowIncome = thisMonthIncome < MIN_SAVINGS_RATE_INCOME_THRESHOLD;
    const isCurrentMonth = (currentYear === now.getFullYear() && currentMonth === now.getMonth());
    const isUnfinishedMonth = isCurrentMonth && (daysElapsed < daysInMonth);

    // Expected income from recurring rules or settings (Requirement 4)
    const activeRecurringIncome = (recurringRules || [])
      .filter(r => (r.status === 'active' || r.status === 'ACTIVE') &&
        String(r.txn_type || '').toLowerCase() === 'income');
    const expectedRecurringIncome = activeRecurringIncome.reduce((sum, r) => sum + (r.amount_per_part || r.amount || 0), 0);
    const configuredExpectedIncome = parseFloat(settings.expectedIncome || settings.monthlyIncome || 0) || 0;
    const expectedIncome = expectedRecurringIncome > 0 ? expectedRecurringIncome : (configuredExpectedIncome > 0 ? configuredExpectedIncome : null);

    // Statistically sound savings rate & cash flow presentation
    let savingsRate = null;
    let savingsRateDisplay = '0%';
    let savingsRateStatus = { label: 'Optimal', color: '#01B574', sublabel: 'Income balanced' };

    if (isUnfinishedMonth) {
      // During an unfinished month, present Month-to-date Cash Flow rather than premature final deficit
      savingsRate = null;
      savingsRateDisplay = thisMonthSavings >= 0 ? `+₹${Math.round(thisMonthSavings).toLocaleString('en-IN')}` : `−₹${Math.abs(Math.round(thisMonthSavings)).toLocaleString('en-IN')}`;
      savingsRateStatus = {
        label: 'Month-to-date Cash Flow',
        color: thisMonthSavings >= 0 ? '#01B574' : '#EE5D50',
        sublabel: `Month in progress (${daysElapsed} of ${daysInMonth} days)${expectedIncome ? ` · Expected: ₹${Math.round(expectedIncome).toLocaleString('en-IN')}` : ''}`
      };
    } else if (isLowIncome) {
      // Completed month with low income baseline: suppress extreme -1788% percentages
      savingsRate = null;
      savingsRateDisplay = isDeficit ? 'Deficit' : 'N/A';
      savingsRateStatus = isDeficit
        ? { label: 'Monthly Deficit', color: '#EE5D50', sublabel: `Expenses exceeded income (Income < ₹${MIN_SAVINGS_RATE_INCOME_THRESHOLD.toLocaleString('en-IN')})` }
        : { label: 'Low Income Baseline', color: '#8FA0BC', sublabel: `Income below ₹${MIN_SAVINGS_RATE_INCOME_THRESHOLD.toLocaleString('en-IN')} threshold` };
    } else {
      savingsRate = Math.round((thisMonthSavings / thisMonthIncome) * 100);
      savingsRateDisplay = `${savingsRate}%`;
      if (savingsRate >= 40) savingsRateStatus = { label: 'Excellent', color: '#01B574', sublabel: 'Exceptional savings rate' };
      else if (savingsRate >= 20) savingsRateStatus = { label: 'Optimal', color: '#00D2D3', sublabel: 'On track with 50/30/20' };
      else if (savingsRate >= 10) savingsRateStatus = { label: 'Moderate', color: '#FFAA00', sublabel: 'Modest savings buffer' };
      else if (savingsRate >= 0) savingsRateStatus = { label: 'Low', color: '#FFAA00', sublabel: 'Thin savings margin' };
      else savingsRateStatus = { label: 'Deficit', color: '#EE5D50', sublabel: 'Expenses exceeded income' };
    }

    const lastMonthIncome = lastMonthBucket.income;
    const lastMonthExpense = lastMonthBucket.expense;
    const lastMonthSavings = lastMonthIncome - lastMonthExpense;

    // Month-over-Month % Changes
    const calcMoMChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / Math.abs(previous)) * 100);
    };

    const momIncomeChange = calcMoMChange(thisMonthIncome, lastMonthIncome);
    const momExpenseChange = calcMoMChange(thisMonthExpense, lastMonthExpense);
    const momSavingsChange = calcMoMChange(thisMonthSavings, lastMonthSavings);

    // ── 3. FINANCIAL HEALTH METRICS ─────────────────────────────────────────────
    // Emergency Runway
    let totalExpenseLast3m = 0;
    for (let i = 0; i < 3; i++) {
      const d = new Date(currentYear, currentMonth - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      totalExpenseLast3m += (monthlyLedger[k]?.expense || 0);
    }
    const avgMonthlyExpense = totalExpenseLast3m / 3 || 1;
    const runwayMonths = Math.max(0, liquidAssets / avgMonthlyExpense);

    // Income vs Expense Ratio
    const incomeExpenseRatio = thisMonthExpense > 0
      ? (thisMonthIncome / thisMonthExpense).toFixed(1)
      : (thisMonthIncome > 0 ? '10+' : '0.0');

    // Expense Pace (burn rate)
    const dailyBurnRate = thisMonthExpense / daysElapsed;
    const projectedMonthExpense = Math.round(dailyBurnRate * daysInMonth);
    const monthTimeElapsedPct = Math.round((daysElapsed / daysInMonth) * 100);
    const projectedVsLastMonthPct = lastMonthExpense > 0
      ? Math.round(((projectedMonthExpense - lastMonthExpense) / lastMonthExpense) * 100)
      : 0;

    // ── 4. CASH FLOW & NET WORTH TIME SERIES (O(M) Fast Cumulative Reconstruction) ──
    const sortedYmKeys = Object.keys(monthlyLedger).sort();
    let runningCumulativeNW = 0;
    const monthlyCumulativeNW = {};
    for (const k of sortedYmKeys) {
      const b = monthlyLedger[k];
      runningCumulativeNW += (b.income - b.expense);
      monthlyCumulativeNW[k] = runningCumulativeNW;
    }

    const buildTimeSeries = (numMonths) => {
      const points = [];
      for (let i = numMonths - 1; i >= 0; i--) {
        const d = new Date(currentYear, currentMonth - i, 1);
        const ymKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const b = monthlyLedger[ymKey] || { income: 0, expense: 0 };
        const nwAtEnd = monthlyCumulativeNW[ymKey] !== undefined ? monthlyCumulativeNW[ymKey] : 0;

        points.push({
          key: ymKey,
          label: MONTHS[d.getMonth()],
          fullLabel: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`,
          year: d.getFullYear(),
          month: d.getMonth(),
          income: Math.round(b.income),
          expense: Math.round(b.expense),
          savings: Math.round(b.income - b.expense),
          netWorth: Math.round(nwAtEnd),
        });
      }
      return points;
    };

    const series6M = buildTimeSeries(6);
    const series12M = buildTimeSeries(12);

    // Yearly Aggregation for Chart & Analysis (Filter zero-activity placeholder years)
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
        fullLabel: `Year ${y.year}`,
        income: Math.round(y.income),
        expense: Math.round(y.expense),
        savings: Math.round(y.savings),
        netWorth: Math.round(runningYearlyNW),
      };
    });

    const isYearlyNetWorthUnavailable = seriesYearly.length === 0 || seriesYearly.every(y => y.netWorth === 0);

    // ── 5. SPENDING INTELLIGENCE ───────────────────────────────────────────────
    // Current month categories
    const currentCats = categoryMonthMap[currentYmKey] || {};
    const lastMonthCats = categoryMonthMap[lastYmKey] || {};

    const topCategoriesThisMonth = Object.entries(currentCats)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => {
        const lastAmt = lastMonthCats[cat] || 0;
        const diff = amt - lastAmt;
        const pctOfTotal = thisMonthExpense > 0 ? Math.round((amt / thisMonthExpense) * 100) : 0;
        return {
          category: cat,
          amount: Math.round(amt),
          lastMonthAmount: Math.round(lastAmt),
          diff: Math.round(diff),
          pctOfTotal,
        };
      });

    // MoM Spikes: Categories with largest absolute increases
    const categorySpikes = Object.entries(currentCats)
      .map(([cat, amt]) => {
        const lastAmt = lastMonthCats[cat] || 0;
        const diff = amt - lastAmt;
        const pctChange = lastAmt > 0 ? Math.round((diff / lastAmt) * 100) : 100;
        return { category: cat, amount: Math.round(amt), diff: Math.round(diff), pctChange };
      })
      .filter(item => item.diff > 500)
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 4);

    // Highest individual expense transactions this month
    const thisMonthExpenses = [];
    for (let i = 0; i < completedTransactions.length; i++) {
      const t = completedTransactions[i];
      if (txnType(t) === 'expense') {
        const d = parseDate(t.Date);
        if (d >= thisMonthStart && d <= todayEnd) {
          thisMonthExpenses.push(t);
        }
      }
    }

    const highestIndividualExpenses = [...thisMonthExpenses]
      .sort((a, b) => txnAmount(b) - txnAmount(a))
      .slice(0, 5)
      .map(t => ({
        id: t._id || t.ID || t.id,
        date: t.Date,
        amount: txnAmount(t),
        category: t.Category || 'Others',
        note: t.Note || t.Description || 'Expense',
        account: t.FromAccount || t.Account || '',
      }));

    // Historical Averages & Peaks
    let totalAllMonthsExpense = 0;
    let peakMonthKey = '';
    let peakMonthAmt = 0;
    const allMonthKeys = Object.keys(monthlyLedger);

    for (const [k, v] of Object.entries(monthlyLedger)) {
      totalAllMonthsExpense += v.expense;
      if (v.expense > peakMonthAmt) {
        peakMonthAmt = v.expense;
        peakMonthKey = k;
      }
    }
    const allTimeAvgMonthlyExpense = allMonthKeys.length > 0 ? Math.round(totalAllMonthsExpense / allMonthKeys.length) : 0;

    let peakMonthDisplay = 'N/A';
    if (peakMonthKey) {
      const [yr, mo] = peakMonthKey.split('-');
      const mName = MONTHS_FULL[parseInt(mo, 10) - 1];
      peakMonthDisplay = `${mName} ${yr}`;
    }

    let peakYearKey = '';
    let peakYearAmt = 0;
    let totalAllYearsExpense = 0;
    const allYearKeys = Object.keys(yearlyMap);

    for (const [yr, v] of Object.entries(yearlyMap)) {
      totalAllYearsExpense += v.expense;
      if (v.expense > peakYearAmt) {
        peakYearAmt = v.expense;
        peakYearKey = yr;
      }
    }
    const allTimeAvgYearlyExpense = allYearKeys.length > 0 ? Math.round(totalAllYearsExpense / allYearKeys.length) : 0;

    const yearlyAnalysisRows = Object.values(yearlyMap)
      .sort((a, b) => b.year.localeCompare(a.year))
      .map(y => ({
        year: y.year,
        total: Math.round(y.expense),
        monthlyAvg: Math.round(y.monthsCount > 0 ? y.expense / y.monthsCount : 0),
        savings: Math.round(y.savings),
      }));

    // Budget Progress Tracking
    const budgetStats = (budgets || []).map(b => {
      const spend = currentCats[b.category] || 0;
      const pct = b.amount > 0 ? Math.round((spend / b.amount) * 100) : 0;
      return {
        category: b.category,
        period: b.period || 'Month',
        amount: b.amount,
        spend: Math.round(spend),
        pct,
        isOver: spend > b.amount,
      };
    });

    // ── 6. DEBT & CREDIT CARDS SUMMARY (Authoritative Shared Engine) ───────────
    const authoritativeDebt = calculateDebtLedgers(transactions);
    const totalLentPending = authoritativeDebt.totalReceivable;
    const totalBorrowedPending = authoritativeDebt.totalPayable;
    const counterparties = authoritativeDebt.counterparties;

    // Credit cards summary
    const creditCardsList = [];
    let totalCcPayable = 0;

    for (const a of accounts) {
      if (isCreditCard(a)) {
        const { balancePayable, outstanding } = ccBalances(transactions, a.name, a.settlementDate, now);
        const daysDue = ccDaysUntilDue(a, now);
        const nextDue = ccNextDueDate(a, now);
        const payable = balancePayable > 0 ? balancePayable : (outstanding > 0 ? outstanding : 0);
        totalCcPayable += payable;

        creditCardsList.push({
          name: a.name,
          balancePayable: Math.round(payable),
          daysDue,
          nextDueDate: nextDue,
          settlementDate: a.settlementDate,
        });
      }
    }

    // ── 7. RECENT TRANSACTIONS & SCHEDULED ALERTS ───────────────────────────────
    // Completed historical transactions: strictly on or before today, sorted date descending
    const recentTxns = [...completedTransactions]
      .sort((a, b) => {
        const da = parseDate(a.Date).getTime() || 0;
        const db = parseDate(b.Date).getTime() || 0;
        return db - da;
      })
      .slice(0, 7)
      .map(t => ({
        id: t._id || t.ID || t.id,
        date: t.Date,
        type: txnType(t),
        amount: txnAmount(t),
        category: t.Category || (txnType(t) === 'transfer' ? 'Transfer' : 'General'),
        note: t.Note || t.Description || '',
        account: t.FromAccount || t.Account || '',
        toAccount: t.ToAccount || '',
      }));

    // Future scheduled / post-dated transactions: sorted date ascending (nearest upcoming first)
    const upcomingScheduledTxns = [...futureTransactions]
      .sort((a, b) => {
        const da = parseDate(a.Date).getTime() || 0;
        const db = parseDate(b.Date).getTime() || 0;
        return da - db;
      })
      .slice(0, 5)
      .map(t => ({
        id: t._id || t.ID || t.id,
        date: t.Date,
        type: txnType(t),
        amount: txnAmount(t),
        category: t.Category || 'Scheduled',
        note: t.Note || t.Description || 'Scheduled Transaction',
        account: t.FromAccount || t.Account || '',
      }));

    // Large transaction alerts (single expense >= ₹10,000 this month)
    const largeTxns = thisMonthExpenses
      .filter(t => txnAmount(t) >= 10000)
      .sort((a, b) => txnAmount(b) - txnAmount(a))
      .slice(0, 4)
      .map(t => ({
        id: t._id || t.ID || t.id,
        date: t.Date,
        amount: txnAmount(t),
        category: t.Category || 'Expense',
        note: t.Note || t.Description || 'Large Transaction',
      }));

    // Unusual Category Spikes (> 130% of 3-month rolling average)
    const unusualSpendingAlerts = [];
    for (const [cat, amt] of Object.entries(currentCats)) {
      if (amt < 1000) continue;
      let sumPast = 0;
      let monthsCount = 0;
      for (let i = 1; i <= 3; i++) {
        const d = new Date(currentYear, currentMonth - i, 1);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (categoryMonthMap[k] && categoryMonthMap[k][cat]) {
          sumPast += categoryMonthMap[k][cat];
          monthsCount++;
        }
      }
      if (monthsCount > 0) {
        const avgPast = sumPast / monthsCount;
        if (avgPast > 0 && amt > avgPast * 1.35) {
          const pctSurge = Math.round(((amt - avgPast) / avgPast) * 100);
          unusualSpendingAlerts.push({
            category: cat,
            currentAmount: Math.round(amt),
            normalAverage: Math.round(avgPast),
            pctSurge,
          });
        }
      }
    }
    unusualSpendingAlerts.sort((a, b) => b.pctSurge - a.pctSurge);

    // Active Upcoming Recurring Rules
    const activeRecurringRules = (recurringRules || [])
      .filter(r => r.rule_type === 'repeat' && r.status === 'active')
      .slice(0, 5)
      .map(r => ({
        id: r._id || r.id,
        category: r.category || 'Recurring',
        amount: r.amount || 0,
        note: r.note || r.description || 'Recurring Rule',
        frequency: r.frequency || 'Monthly',
        nextDate: r.next_due_date || r.start_date || '',
      }));

    return {
      currentYear,
      currentMonth,
      monthLabel: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      netWorth: Math.round(netWorth),
      assets: Math.round(assets),
      liabilities: Math.round(liabilities),
      monthlyIncome: Math.round(thisMonthIncome),
      monthlyExpenses: Math.round(thisMonthExpense),
      monthlySavings: Math.round(thisMonthSavings),
      isDeficit,
      isLowIncome,
      isUnfinishedMonth,
      daysElapsed,
      daysInMonth,
      expectedIncome,
      savingsRate,
      savingsRateDisplay,
      savingsRateStatus,
      monthly: {
        isUnfinishedMonth,
        daysElapsed,
        daysInMonth,
        expectedIncome,
        income: Math.round(thisMonthIncome),
        expenses: Math.round(thisMonthExpense),
        savings: Math.round(thisMonthSavings),
      },
      momIncomeChange,
      momExpenseChange,
      momSavingsChange,
      health: {
        runwayMonths: Number(runwayMonths.toFixed(1)),
        liquidAssets: Math.round(liquidAssets),
        avgMonthlyExpense: Math.round(avgMonthlyExpense),
        incomeExpenseRatio,
        monthlyInvested: Math.round(monthlyInvested),
        totalInvested: Math.round(totalInvested),
        dailyBurnRate: Math.round(dailyBurnRate),
        projectedMonthExpense,
        monthTimeElapsedPct,
        projectedVsLastMonthPct,
      },
      timeSeries: {
        series6M,
        series12M,
        seriesYearly,
        isYearlyNetWorthUnavailable,
      },
      spending: {
        topCategories: topCategoriesThisMonth,
        spikes: categorySpikes,
        highestExpenses: highestIndividualExpenses,
        historical: {
          allTimeAvgMonthly: allTimeAvgMonthlyExpense,
          allTimeAvgYearly: allTimeAvgYearlyExpense,
          peakMonth: peakMonthDisplay,
          peakMonthAmt: Math.round(peakMonthAmt),
          peakYear: peakYearKey,
          peakYearAmt: Math.round(peakYearAmt),
          yearlyRows: yearlyAnalysisRows,
        },
        budgets: budgetStats,
      },
      debt: {
        totalReceivables: Math.round(totalLentPending),
        totalPayables: Math.round(totalBorrowedPending),
        counterpartiesCount: counterparties.length,
        topCounterparties: counterparties.slice(0, 8),
      },
      creditCards: {
        cards: creditCardsList,
        totalPayable: Math.round(totalCcPayable),
      },
      activityAndAlerts: {
        recentTxns,
        upcomingScheduledTxns,
        largeTxns,
        unusualAlerts: unusualSpendingAlerts.slice(0, 3),
        upcomingRecurring: activeRecurringRules,
      },
    };
  }, [transactions, accounts, budgets, recurringRules, settings, now]);
}
