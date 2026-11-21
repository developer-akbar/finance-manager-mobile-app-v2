/**
 * src/tests/openai_synthetic_tools.test.js
 *
 * Automated Test Suite for FinMan Phase OAI-1: Synthetic Financial Tool Registry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeSyntheticTool,
  formatSafeINR,
  formatDeterministicAnswer
} from '../server/ai/syntheticToolRegistry.js';
import { validateToolInvocation, ToolValidationError } from '../server/ai/toolValidators.js';
import { ALLOWED_TOOL_NAMES } from '../server/ai/toolSchemas.js';

test('FinMan Phase OAI-1 — Synthetic Financial Tools Suite', async (t) => {

  await t.test('1. Tool Registry Allowlist: Exactly 9 approved read-only tools', () => {
    assert.equal(ALLOWED_TOOL_NAMES.size, 9);
    assert.ok(ALLOWED_TOOL_NAMES.has('getFinancialSummary'));
    assert.ok(ALLOWED_TOOL_NAMES.has('getAccountBalances'));
    assert.ok(ALLOWED_TOOL_NAMES.has('getMonthlyCashFlow'));
    assert.ok(ALLOWED_TOOL_NAMES.has('getCategorySpending'));
    assert.ok(ALLOWED_TOOL_NAMES.has('getTopExpenseCategories'));
    assert.ok(ALLOWED_TOOL_NAMES.has('getInvestmentHoldings'));
    assert.ok(ALLOWED_TOOL_NAMES.has('getPortfolioSummary'));
    assert.ok(ALLOWED_TOOL_NAMES.has('getLiabilities'));
    assert.ok(ALLOWED_TOOL_NAMES.has('searchTransactions'));
  });

  await t.test('2. Security: Unauthorized tools and arbitrary code execution blocked', () => {
    assert.throws(
      () => validateToolInvocation('executeRawQuery', { query: 'DROP TABLE accounts;' }),
      ToolValidationError
    );
    assert.throws(
      () => validateToolInvocation('transferFunds', { amount: 5000 }),
      ToolValidationError
    );
    assert.throws(
      () => validateToolInvocation('eval', { code: 'process.exit(1)' }),
      ToolValidationError
    );
  });

  await t.test('3. INR Formatting Helper: Handles positive, negative, zero, and decimals', () => {
    assert.equal(formatSafeINR(150000), '₹1,50,000');
    assert.equal(formatSafeINR(-4941), '-₹4,941');
    assert.equal(formatSafeINR(0), '₹0');
    assert.equal(formatSafeINR(1234567.89, 2), '₹12,34,567.89');
    assert.equal(formatSafeINR(-12500.5, 2), '-₹12,500.50');
  });

  await t.test('4. getAccountBalances: Calculates exact net worth, assets, and liabilities', () => {
    const result = executeSyntheticTool('getAccountBalances', {});

    assert.equal(result.isDemoData, true);
    assert.equal(result.currency, 'INR');
    assert.equal(result.totalBankBalance, 240000); // Demo Bank A (55k) + Demo Bank B (185k)
    assert.equal(result.totalInvestments, 923150); // Equity (354.5k) + MF (568.65k)
    assert.equal(result.totalLiquidCash, 245000); // Bank + Cash Wallet (5k)
    assert.equal(result.totalAssets, 1168150);    // Liquid (245k) + Investments (923.15k)
    assert.equal(result.totalLiabilities, 23950); // CC Debt (23,950)
    assert.equal(result.netWorth, 1144200);       // Assets - Liabilities = 1,144,200

    // Ensure all 6 synthetic accounts are present
    assert.equal(result.accounts.length, 6);
  });

  await t.test('5. getFinancialSummary: Correctly aggregates income and expense periods', () => {
    // October 2026 (Completed Month)
    const octSummary = executeSyntheticTool('getFinancialSummary', { period: '2026-10' });
    assert.equal(octSummary.income, 150000);
    assert.equal(octSummary.expenses, 67900); // 35k rent + 8.5k groc + 4.2k dine + 3.2k util + 12.5k shop + 4.5k groc
    assert.equal(octSummary.netSavings, 82100);
    assert.equal(octSummary.savingsRate, '55%');
    assert.equal(octSummary.incomeTransactionCount, 1);
    assert.equal(octSummary.expenseTransactionCount, 6);

    // November 2026 (this_month)
    const novSummary = executeSyntheticTool('getFinancialSummary', { period: 'this_month' });
    assert.equal(novSummary.income, 150000);
    assert.equal(novSummary.expenses, 50549); // 35k + 6.8k + 1850 + 1499 + 5400
    assert.equal(novSummary.netSavings, 99451);
  });

  await t.test('6. getMonthlyCashFlow: Calculates burn rate and pacing correctly', () => {
    const cf = executeSyntheticTool('getMonthlyCashFlow', { period: 'this_month' });
    assert.equal(cf.totalIncome, 150000);
    assert.equal(cf.totalExpenses, 50549);
    assert.equal(cf.netCashFlow, 99451);
    assert.ok(cf.dailyBurnRate > 0);
    assert.equal(cf.daysInMonth, 30);
  });

  await t.test('7. getCategorySpending: Returns matching category total and transactions', () => {
    const grocOct = executeSyntheticTool('getCategorySpending', { category: 'Groceries', period: '2026-10' });
    assert.equal(grocOct.category, 'Groceries');
    assert.equal(grocOct.totalSpent, 13000); // 8500 + 4500
    assert.equal(grocOct.transactionCount, 2);

    // Missing category parameter fails validation
    assert.throws(
      () => validateToolInvocation('getCategorySpending', {}),
      ToolValidationError
    );
  });

  await t.test('8. getTopExpenseCategories: Ranks categories and respects limit', () => {
    const top = executeSyntheticTool('getTopExpenseCategories', { period: '2026-10', limit: 3 });
    assert.equal(top.topCategories.length, 3);
    assert.equal(top.topCategories[0].category, 'Rent');
    assert.equal(top.topCategories[0].amount, 35000);
    assert.ok(top.topCategories[0].percentage.includes('%'));
  });

  await t.test('9. getInvestmentHoldings & getPortfolioSummary: Accurately maps unified portfolio', () => {
    const holdings = executeSyntheticTool('getInvestmentHoldings', {});
    assert.equal(holdings.holdingCount, 4);
    assert.equal(holdings.totalInvestedCost, 786000);
    assert.equal(holdings.totalCurrentValue, 923150);
    assert.equal(holdings.unrealizedPnl, 137150);
    assert.equal(holdings.returnPercent, 17.45);

    const summary = executeSyntheticTool('getPortfolioSummary', {});
    assert.equal(summary.totalInvested, 786000);
    assert.equal(summary.totalCurrentValue, 923150);
    assert.equal(summary.unrealizedGain, 137150);
    assert.equal(summary.returnRate, '17.45%');
  });

  await t.test('10. getLiabilities: Returns credit card breakdown with due dates', () => {
    const liabilities = executeSyntheticTool('getLiabilities', {});
    assert.equal(liabilities.totalLiabilities, 23950);
    assert.equal(liabilities.creditCards.length, 1);
    assert.equal(liabilities.creditCards[0].billedPayable, 16700);
    assert.equal(liabilities.creditCards[0].unbilledOutstanding, 7250);
    assert.equal(liabilities.creditCards[0].paymentDueDate, '2026-12-08');
  });

  await t.test('11. searchTransactions: Requires search filters and enforces pagination clamp', () => {
    // Unfiltered search blocked
    assert.throws(
      () => validateToolInvocation('searchTransactions', {}),
      ToolValidationError
    );

    // Valid search by category
    const res = executeSyntheticTool('searchTransactions', { category: 'Groceries' });
    assert.ok(res.totalMatches >= 3);
    assert.ok(res.transactions.every(t => t.category.includes('Groceries')));

    // Pagination limit clamped to 15
    const args = validateToolInvocation('searchTransactions', { searchTerm: 'Demo', limit: 50 });
    assert.equal(args.limit, 15);
  });

  await t.test('12. Deterministic Formatter: Produces exact INR markdown for balances', () => {
    const balResult = executeSyntheticTool('getAccountBalances', {});
    const md = formatDeterministicAnswer('getAccountBalances', balResult);

    assert.ok(md.includes('₹11,44,200'), 'Includes Net Worth');
    assert.ok(md.includes('₹11,68,150'), 'Includes Total Assets');
    assert.ok(md.includes('₹23,950'), 'Includes Total Liabilities');
    assert.ok(md.includes('Demo Bank A (Savings)'));
    assert.ok(md.includes('Demo Share Market Demat'));
    assert.ok(!md.includes('$'), 'Strictly excludes dollar sign');
  });

});
