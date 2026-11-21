/**
 * src/server/ai/syntheticToolRegistry.js
 *
 * Deterministic Synthetic Financial Tool Registry for FinMan OpenAI POC.
 * Read-only domain calculations operating strictly on isolated synthetic fixtures.
 */

import {
  SYNTHETIC_REFERENCE_DATE,
  SYNTHETIC_ACCOUNTS,
  SYNTHETIC_TRANSACTIONS,
  SYNTHETIC_HOLDINGS
} from './syntheticFinancialFixtures.js';
import { validateToolInvocation, formatSafeToolResult } from './toolValidators.js';

export function formatSafeINR(amount, decimals = 0) {
  const num = Number(amount) || 0;
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return num < 0 ? `-₹${formatted}` : `₹${formatted}`;
}

export function resolvePeriodDateRange(period = 'this_month', refDate = SYNTHETIC_REFERENCE_DATE) {
  const year = refDate.getFullYear();
  const month = refDate.getMonth(); // 10 = November

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  if (period === 'last_month') {
    const prevMonthDate = new Date(year, month - 1, 1);
    const y = prevMonthDate.getFullYear();
    const m = prevMonthDate.getMonth();
    return {
      periodKey: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: `${MONTH_NAMES[m]} ${y}`,
      start: new Date(y, m, 1, 0, 0, 0, 0),
      end: new Date(y, m + 1, 0, 23, 59, 59, 999),
      isCurrentMonth: false
    };
  }

  if (/^\d{4}-\d{2}$/.test(period)) {
    const [yStr, mStr] = period.split('-');
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10) - 1;
    if (m >= 0 && m <= 11) {
      return {
        periodKey: period,
        label: `${MONTH_NAMES[m]} ${y}`,
        start: new Date(y, m, 1, 0, 0, 0, 0),
        end: new Date(y, m + 1, 0, 23, 59, 59, 999),
        isCurrentMonth: (y === year && m === month)
      };
    }
  }

  // Default: this_month (November 2026)
  return {
    periodKey: `${year}-${String(month + 1).padStart(2, '0')}`,
    label: `${MONTH_NAMES[month]} ${year}`,
    start: new Date(year, month, 1, 0, 0, 0, 0),
    end: new Date(year, month + 1, 0, 23, 59, 59, 999),
    isCurrentMonth: true
  };
}

export function executeSyntheticTool(toolName, rawArgs = {}) {
  const cleanArgs = validateToolInvocation(toolName, rawArgs);

  switch (toolName) {
    case 'getFinancialSummary': {
      const range = resolvePeriodDateRange(cleanArgs.period);
      let income = 0;
      let expenses = 0;
      let incomeCount = 0;
      let expenseCount = 0;

      for (const tx of SYNTHETIC_TRANSACTIONS) {
        const txDate = new Date(tx.date + 'T00:00:00');
        if (txDate < range.start || txDate > range.end) continue;

        if (tx.type === 'Income') {
          income += tx.inr;
          incomeCount++;
        } else if (tx.type === 'Expense') {
          expenses += tx.inr;
          expenseCount++;
        }
      }

      const netSavings = Math.round((income - expenses) * 100) / 100;
      const savingsRate = income > 0 ? Math.round((netSavings / income) * 100) : 0;

      return {
        period: range.label,
        periodKey: range.periodKey,
        income,
        expenses,
        netSavings,
        savingsRate: `${savingsRate}%`,
        incomeTransactionCount: incomeCount,
        expenseTransactionCount: expenseCount,
        currency: 'INR',
        isDemoData: true
      };
    }

    case 'getAccountBalances': {
      // 1. Bank balances computed from synthetic ledger
      let bankASavings = 55000;  // Demo Bank A
      let bankBSalary = 185000;  // Demo Bank B
      let cashWallet = 5000;     // Demo Cash Wallet

      // 2. Investment holdings market values
      const equityVal = 162000 + 192500; // Infosys + TCS = 354,500
      const mfVal = 356250 + 212400;     // Nifty 50 + Bluechip = 568,650
      const totalInvestments = equityVal + mfVal; // 923,150

      // 3. Credit Card liability
      // October shopping + dining (12500 + 4200 = 16,700) + Nov dining + shopping (1850 + 5400 = 7,250)
      const ccDebt = 23950;

      const accounts = [
        {
          name: 'Demo Bank A (Savings)',
          group: 'Bank Accounts',
          type: 'Savings',
          isAsset: true,
          balance: bankASavings,
          currency: 'INR'
        },
        {
          name: 'Demo Bank B (Salary)',
          group: 'Bank Accounts',
          type: 'Salary',
          isAsset: true,
          balance: bankBSalary,
          currency: 'INR'
        },
        {
          name: 'Demo Cash Wallet',
          group: 'Cash',
          type: 'Cash',
          isAsset: true,
          balance: cashWallet,
          currency: 'INR'
        },
        {
          name: 'Demo Share Market Demat',
          group: 'Investments',
          type: 'Equity Portfolio',
          isAsset: true,
          balance: equityVal,
          currency: 'INR'
        },
        {
          name: 'Demo Mutual Funds Portfolio',
          group: 'Investments',
          type: 'Mutual Funds',
          isAsset: true,
          balance: mfVal,
          currency: 'INR'
        },
        {
          name: 'Demo Credit Card Platinum',
          group: 'Credit Cards',
          type: 'Credit Card',
          isAsset: false,
          balance: -ccDebt,
          billedPayable: 16700,
          unbilledOutstanding: 7250,
          currency: 'INR'
        }
      ];

      const totalBankCash = bankASavings + bankBSalary + cashWallet; // 245,000
      const totalAssets = totalBankCash + totalInvestments; // 1,168,150
      const totalLiabilities = ccDebt; // 23,950
      const netWorth = totalAssets - totalLiabilities; // 1,144,200

      return {
        netWorth,
        totalAssets,
        totalLiabilities,
        totalBankBalance: bankASavings + bankBSalary,
        totalLiquidCash: totalBankCash,
        totalInvestments,
        accounts,
        currency: 'INR',
        isDemoData: true
      };
    }

    case 'getMonthlyCashFlow': {
      const range = resolvePeriodDateRange(cleanArgs.period);
      let income = 0;
      let expenses = 0;

      for (const tx of SYNTHETIC_TRANSACTIONS) {
        const txDate = new Date(tx.date + 'T00:00:00');
        if (txDate < range.start || txDate > range.end) continue;
        if (tx.type === 'Income') income += tx.inr;
        else if (tx.type === 'Expense') expenses += tx.inr;
      }

      const daysInMonth = range.end.getDate();
      const daysElapsed = range.isCurrentMonth
        ? Math.min(daysInMonth, Math.max(1, SYNTHETIC_REFERENCE_DATE.getDate()))
        : daysInMonth;

      const dailyBurnRate = Math.round((expenses / daysElapsed) * 100) / 100;
      const projectedExpenses = Math.round(dailyBurnRate * daysInMonth);
      const netCashFlow = income - expenses;

      return {
        period: range.label,
        totalIncome: income,
        totalExpenses: expenses,
        netCashFlow,
        dailyBurnRate,
        daysElapsed,
        daysInMonth,
        projectedMonthExpense: projectedExpenses,
        currency: 'INR',
        isDemoData: true
      };
    }

    case 'getCategorySpending': {
      const targetCat = cleanArgs.category.toLowerCase();
      const range = resolvePeriodDateRange(cleanArgs.period);

      let totalSpent = 0;
      const matchingTxs = [];

      for (const tx of SYNTHETIC_TRANSACTIONS) {
        if (tx.type !== 'Expense') continue;
        const txDate = new Date(tx.date + 'T00:00:00');
        if (txDate < range.start || txDate > range.end) continue;

        if (tx.category.toLowerCase().includes(targetCat)) {
          totalSpent += tx.inr;
          matchingTxs.push({
            date: tx.date,
            account: tx.account,
            subcategory: tx.subcategory,
            amount: tx.inr,
            note: tx.note
          });
        }
      }

      return {
        category: cleanArgs.category,
        period: range.label,
        totalSpent,
        transactionCount: matchingTxs.length,
        transactions: matchingTxs,
        currency: 'INR',
        isDemoData: true
      };
    }

    case 'getTopExpenseCategories': {
      const range = resolvePeriodDateRange(cleanArgs.period);
      const catTotals = {};
      let grandTotal = 0;

      for (const tx of SYNTHETIC_TRANSACTIONS) {
        if (tx.type !== 'Expense') continue;
        const txDate = new Date(tx.date + 'T00:00:00');
        if (txDate < range.start || txDate > range.end) continue;

        catTotals[tx.category] = (catTotals[tx.category] || 0) + tx.inr;
        grandTotal += tx.inr;
      }

      const sorted = Object.entries(catTotals)
        .map(([category, amount]) => ({
          category,
          amount,
          percentage: grandTotal > 0 ? `${Math.round((amount / grandTotal) * 1000) / 10}%` : '0%'
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, cleanArgs.limit || 5);

      return {
        period: range.label,
        totalExpenses: grandTotal,
        topCategories: sorted,
        currency: 'INR',
        isDemoData: true
      };
    }

    case 'getInvestmentHoldings': {
      let totalCost = 0;
      let totalValue = 0;

      const holdings = SYNTHETIC_HOLDINGS.map(h => {
        totalCost += h.investedCost;
        totalValue += h.currentValue;
        return { ...h, currency: 'INR' };
      });

      const unrealizedPnl = Math.round((totalValue - totalCost) * 100) / 100;
      const returnPercent = totalCost > 0 ? Math.round((unrealizedPnl / totalCost) * 10000) / 100 : 0;

      return {
        holdingCount: holdings.length,
        totalInvestedCost: totalCost,
        totalCurrentValue: totalValue,
        unrealizedPnl,
        returnPercent,
        holdings,
        currency: 'INR',
        isDemoData: true
      };
    }

    case 'getPortfolioSummary': {
      let equityCost = 0;
      let equityValue = 0;
      let mfCost = 0;
      let mfValue = 0;

      for (const h of SYNTHETIC_HOLDINGS) {
        if (h.assetType === 'EQUITY') {
          equityCost += h.investedCost;
          equityValue += h.currentValue;
        } else {
          mfCost += h.investedCost;
          mfValue += h.currentValue;
        }
      }

      const totalInvested = equityCost + mfCost;
      const totalValue = equityValue + mfValue;
      const unrealizedGain = totalValue - totalInvested;
      const returnRate = totalInvested > 0 ? Math.round((unrealizedGain / totalInvested) * 10000) / 100 : 0;

      return {
        totalInvested,
        totalCurrentValue: totalValue,
        unrealizedGain,
        returnRate: `${returnRate}%`,
        assetAllocation: {
          equity: {
            invested: equityCost,
            currentValue: equityValue,
            percentage: `${Math.round((equityValue / totalValue) * 100)}%`
          },
          mutualFunds: {
            invested: mfCost,
            currentValue: mfValue,
            percentage: `${Math.round((mfValue / totalValue) * 100)}%`
          }
        },
        currency: 'INR',
        isDemoData: true
      };
    }

    case 'getLiabilities': {
      return {
        totalLiabilities: 23950,
        currency: 'INR',
        creditCards: [
          {
            cardName: 'Demo Credit Card Platinum',
            totalDebt: 23950,
            billedPayable: 16700,
            unbilledOutstanding: 7250,
            paymentDueDate: '2026-12-08',
            currency: 'INR'
          }
        ],
        loans: [],
        isDemoData: true
      };
    }

    case 'searchTransactions': {
      let filtered = SYNTHETIC_TRANSACTIONS.filter(t => {
        if (cleanArgs.category && !t.category.toLowerCase().includes(cleanArgs.category.toLowerCase())) return false;
        if (cleanArgs.account && !t.account.toLowerCase().includes(cleanArgs.account.toLowerCase())) return false;
        if (cleanArgs.type && t.type !== cleanArgs.type) return false;
        if (cleanArgs.searchTerm) {
          const term = cleanArgs.searchTerm.toLowerCase();
          const noteMatch = (t.note || '').toLowerCase().includes(term);
          const subcatMatch = (t.subcategory || '').toLowerCase().includes(term);
          const catMatch = (t.category || '').toLowerCase().includes(term);
          if (!noteMatch && !subcatMatch && !catMatch) return false;
        }
        if (cleanArgs.minAmount !== undefined && t.inr < cleanArgs.minAmount) return false;
        if (cleanArgs.maxAmount !== undefined && t.inr > cleanArgs.maxAmount) return false;
        if (cleanArgs.startDate && t.date < cleanArgs.startDate) return false;
        if (cleanArgs.endDate && t.date > cleanArgs.endDate) return false;
        return true;
      });

      // Sort DESC by date
      filtered.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

      const totalMatches = filtered.length;
      const offset = cleanArgs.offset || 0;
      const limit = cleanArgs.limit || 5;
      const slice = filtered.slice(offset, offset + limit);

      return formatSafeToolResult({
        totalMatches,
        returnedCount: slice.length,
        offset,
        limit,
        transactions: slice.map(t => ({
          id: t.id,
          date: t.date,
          account: t.account,
          category: t.category,
          subcategory: t.subcategory,
          amount: t.inr,
          formattedAmount: formatSafeINR(t.inr),
          type: t.type,
          note: t.note
        })),
        currency: 'INR',
        isDemoData: true
      }, limit);
    }

    default:
      throw new Error(`Unhandled synthetic tool: ${toolName}`);
  }
}

/**
 * Deterministically formats simple financial tool results directly in INR
 * without requiring an additional LLM synthesis pass.
 */
export function formatDeterministicAnswer(toolName, result) {
  if (!result || typeof result !== 'object') return null;

  switch (toolName) {
    case 'getAccountBalances': {
      const bankAccts = (result.accounts || []).filter(a => a.group === 'Bank Accounts');
      const invAccts = (result.accounts || []).filter(a => a.group === 'Investments');
      const ccAccts = (result.accounts || []).filter(a => a.group === 'Credit Cards');
      const cashAccts = (result.accounts || []).filter(a => a.group === 'Cash');

      return [
        `### 💼 Demo Financial Overview`,
        `- **Net Worth**: ${formatSafeINR(result.netWorth)}`,
        `- **Total Assets**: ${formatSafeINR(result.totalAssets)}`,
        `- **Total Liabilities**: ${formatSafeINR(result.totalLiabilities)}`,
        ``,
        `#### 📁 Bank & Liquid Accounts (${formatSafeINR(result.totalLiquidCash)})`,
        ...bankAccts.map(a => `- **${a.name}**: ${formatSafeINR(a.balance)}`),
        ...cashAccts.map(a => `- **${a.name}**: ${formatSafeINR(a.balance)}`),
        ``,
        `#### 📈 Investments (${formatSafeINR(result.totalInvestments)})`,
        ...invAccts.map(a => `- **${a.name}**: ${formatSafeINR(a.balance)}`),
        ``,
        `#### 💳 Credit Cards & Liabilities (${formatSafeINR(result.totalLiabilities)})`,
        ...ccAccts.map(a => `- **${a.name}**: Billed ${formatSafeINR(a.billedPayable)} • Outstanding ${formatSafeINR(a.unbilledOutstanding)}`)
      ].join('\n');
    }

    case 'getFinancialSummary': {
      return [
        `### 📊 Demo Financial Summary (${result.period})`,
        `- **Total Income**: ${formatSafeINR(result.income)} (${result.incomeTransactionCount} transaction${result.incomeTransactionCount === 1 ? '' : 's'})`,
        `- **Total Expenses**: ${formatSafeINR(result.expenses)} (${result.expenseTransactionCount} transaction${result.expenseTransactionCount === 1 ? '' : 's'})`,
        `- **Net Savings**: ${formatSafeINR(result.netSavings)}`,
        `- **Savings Rate**: **${result.savingsRate}**`
      ].join('\n');
    }

    case 'getTopExpenseCategories': {
      return [
        `### 🏷️ Top Spending Categories (${result.period})`,
        `**Total Expenses Analyzed**: ${formatSafeINR(result.totalExpenses)}`,
        ``,
        ...(result.topCategories || []).map((c, i) => `${i + 1}. **${c.category}**: ${formatSafeINR(c.amount)} (${c.percentage})`)
      ].join('\n');
    }

    case 'getPortfolioSummary': {
      return [
        `### 📈 Demo Investment Portfolio Summary`,
        `- **Total Invested Cost**: ${formatSafeINR(result.totalInvested)}`,
        `- **Current Portfolio Value**: ${formatSafeINR(result.totalCurrentValue)}`,
        `- **Unrealized Gain / Return**: **+${formatSafeINR(result.unrealizedGain)}** (${result.returnRate})`,
        ``,
        `**Asset Allocation:**`,
        `- **Equity / Shares**: ${formatSafeINR(result.assetAllocation?.equity?.currentValue)} (${result.assetAllocation?.equity?.percentage})`,
        `- **Mutual Funds**: ${formatSafeINR(result.assetAllocation?.mutualFunds?.currentValue)} (${result.assetAllocation?.mutualFunds?.percentage})`
      ].join('\n');
    }

    case 'getLiabilities': {
      return [
        `### 💳 Outstanding Liabilities & Credit Cards`,
        `- **Total Debt**: ${formatSafeINR(result.totalLiabilities)}`,
        ...(result.creditCards || []).map(cc => `- **${cc.cardName}**: Payable ${formatSafeINR(cc.billedPayable)} • Outstanding ${formatSafeINR(cc.unbilledOutstanding)} (Due ${cc.paymentDueDate})`)
      ].join('\n');
    }

    default:
      return null;
  }
}

