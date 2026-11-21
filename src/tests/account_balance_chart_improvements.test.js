/**
 * src/tests/account_balance_chart_improvements.test.js
 *
 * Automated Test Suite for FinMan Drilled-Down Account Balance Chart Improvements:
 * 1. Credit card zero balance appears at the bottom of the chart scale (starts at 0).
 * 2. Increasing outstanding balance moves upwards (larger debt = larger positive value on chart).
 * 3. Negative underlying liability values are transformed only for chart presentation via toAccountChartValue.
 * 4. Actual account balances remain unchanged (underlying computeBalance returns negative values).
 * 5. Bank account chart values retain their existing sign semantics.
 * 6. All tab includes earliest and latest available historical data in chronological order.
 * 7. Monthly aggregation produces exactly one point per unique calendar month.
 * 8. Missing historical months do not receive fabricated placeholder values.
 * 9. Custom and other period filters (Month, Year, FY, CC Cycle) remain fully functional.
 * 10. Empty history and zero-balance cases are handled gracefully.
 * 11. Chart titles and tooltips correctly adapt between Credit Cards and Bank accounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import * as formatUtils from '../utils/format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

test('FinMan — Drilled-Down Account Balance Chart Improvements Suite', async (t) => {

  const acctPath = path.join(projectRoot, 'src/components/Accounts/Accounts.jsx');
  assert.ok(fs.existsSync(acctPath), 'Accounts.jsx must exist');
  const acctContent = fs.readFileSync(acctPath, 'utf8').replace(/\r\n/g, '\n');

  // Extract pure logic helper functions from Accounts.jsx into an isolated VM context
  const cbStart = acctContent.indexOf('function computeBalance(');
  const cbEnd = acctContent.indexOf('export function toAccountChartValue');
  const cbStr = acctContent.slice(cbStart, cbEnd);

  const toChartStart = acctContent.indexOf('export function toAccountChartValue');
  const toChartEnd = acctContent.indexOf('export function formatAccountBalanceChartData');
  const toChartStr = acctContent.slice(toChartStart, toChartEnd).replace('export function', 'function');

  const fmtStart = acctContent.indexOf('export function formatAccountBalanceChartData');
  const fmtEnd = acctContent.indexOf('// Build a full balance map');
  const fmtStr = acctContent.slice(fmtStart, fmtEnd).replace('export function', 'function');

  const context = {
    ...formatUtils,
    MS_S: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    MS_F: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  };
  vm.createContext(context);
  vm.runInContext(cbStr, context);
  vm.runInContext(toChartStr, context);
  vm.runInContext(fmtStr, context);

  const { toAccountChartValue, formatAccountBalanceChartData } = context;

  assert.equal(typeof toAccountChartValue, 'function', 'toAccountChartValue must be extracted successfully');
  assert.equal(typeof formatAccountBalanceChartData, 'function', 'formatAccountBalanceChartData must be extracted successfully');

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 1: Credit card zero balance starts at bottom of chart scale
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('1. Credit card zero balance maps to 0 and Y-axis domain starts at 0', () => {
    const chartValZero = toAccountChartValue(0, true);
    assert.strictEqual(chartValZero, 0, 'Zero raw balance must map to 0 on credit card chart');

    // Verify YAxis domain configuration in Accounts.jsx
    assert.ok(
      acctContent.includes("domain={isCreditCardAccount ? [0, dataMax => (dataMax > 0 ? Math.ceil(dataMax * 1.05) : 1000)] : ['auto', 'auto']}"),
      'YAxis domain must start at 0 for credit card accounts'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 2: Increasing outstanding balance moves upwards
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('2. Increasing outstanding debt moves strictly upwards (larger debt = larger positive chart value)', () => {
    // In FinMan credit cards:
    // raw balance 0      -> 0 debt
    // raw balance -2000  -> 2,000 debt
    // raw balance -4000  -> 4,000 debt
    // raw balance -8000  -> 8,000 debt
    const val0 = toAccountChartValue(0, true);
    const val2k = toAccountChartValue(-2000, true);
    const val4k = toAccountChartValue(-4000, true);
    const val8k = toAccountChartValue(-8000, true);

    assert.strictEqual(val0, 0);
    assert.strictEqual(val2k, 2000);
    assert.strictEqual(val4k, 4000);
    assert.strictEqual(val8k, 8000);

    assert.ok(val2k > val0, '2K debt must be higher than 0 debt');
    assert.ok(val4k > val2k, '4K debt must be higher than 2K debt');
    assert.ok(val8k > val4k, '8K debt must be higher than 4K debt');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 3: Negative underlying liability values transformed only for chart
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('3. Negative liability values are transformed to positive magnitude only for chart presentation', () => {
    const rawLiability = -15499.50;
    const chartPresented = toAccountChartValue(rawLiability, true);

    assert.strictEqual(chartPresented, 15499.50, 'Chart value must be the positive magnitude');
    assert.strictEqual(rawLiability, -15499.50, 'Original raw liability value must remain negative');

    // Overpayment / surplus on credit card (raw balance > 0) maps to 0 outstanding debt
    const rawCreditSurplus = 500;
    const chartSurplus = toAccountChartValue(rawCreditSurplus, true);
    assert.strictEqual(chartSurplus, 0, 'Surplus on credit card maps to 0 outstanding debt');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 4: Actual account balances remain unchanged
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('4. Actual account financial calculations and computeBalance remain untouched', () => {
    // Sample transactions on a credit card
    const ccTxns = [
      { Date: '01/01/2026', 'Income/Expense': 'Expense', Account: 'HDFC CC', Amount: 3000 },
      { Date: '15/01/2026', 'Income/Expense': 'Expense', Account: 'HDFC CC', Amount: 5000 },
      { Date: '20/01/2026', 'Income/Expense': 'Income', Account: 'HDFC CC', Amount: 2000 }, // repayment
    ];

    // Check chart aggregation for this credit card
    const chartData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: ccTxns,
      acctName: 'HDFC CC',
      isCreditCardAccount: true,
    });

    assert.strictEqual(chartData.length, 1);
    // Net balance in real accounts: -3000 - 5000 + 2000 = -6000
    // Chart presentation value: 6000
    assert.strictEqual(chartData[0].value, 6000, 'Chart displays positive 6000 outstanding balance');

    // Verify closing balance display in Accounts.jsx continues to use closingBal unaltered
    assert.ok(
      acctContent.includes("className={`acct-banking-v ${(isMFAcct ? mfActiveCost : closingBal) >= 0 ? 'income' : 'expense'}`}"),
      'Account closing balance display in DOM continues to use raw closingBal'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 5: Bank account chart values retain their existing sign semantics
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('5. Bank account chart values retain original sign semantics (positive & overdraft)', () => {
    assert.strictEqual(toAccountChartValue(50000, false), 50000);
    assert.strictEqual(toAccountChartValue(-1200, false), -1200, 'Negative bank overdraft retains negative value');
    assert.strictEqual(toAccountChartValue(0, false), 0);

    const bankTxns = [
      { Date: '10/01/2026', 'Income/Expense': 'Income', Account: 'HDFC Bank', Amount: 100000 },
      { Date: '20/01/2026', 'Income/Expense': 'Expense', Account: 'HDFC Bank', Amount: 30000 },
    ];

    const chartData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: bankTxns,
      acctName: 'HDFC Bank',
      isCreditCardAccount: false,
    });

    assert.strictEqual(chartData.length, 1);
    assert.strictEqual(chartData[0].value, 70000, 'Bank account retains positive 70000 balance');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 6: All tab includes earliest to latest historical data chronologically
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('6. All tab includes earliest to latest historical data in chronological order', () => {
    const historicalTxns = [
      { Date: '14/11/2026', 'Income/Expense': 'Expense', Account: 'SBI', Amount: 500 },
      { Date: '05/03/2024', 'Income/Expense': 'Income', Account: 'SBI', Amount: 10000 },
      { Date: '22/08/2025', 'Income/Expense': 'Expense', Account: 'SBI', Amount: 2000 },
      { Date: '10/01/2024', 'Income/Expense': 'Income', Account: 'SBI', Amount: 5000 },
    ];

    const chartData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: historicalTxns,
      acctName: 'SBI',
      isCreditCardAccount: false,
    });

    assert.strictEqual(chartData.length, 4, 'Should contain 4 distinct months');
    // Chronological order: Jan 2024 -> Mar 2024 -> Aug 2025 -> Nov 2026
    assert.strictEqual(chartData[0].fullLabel, 'January 2024');
    assert.strictEqual(chartData[0].value, 5000); // 5000

    assert.strictEqual(chartData[1].fullLabel, 'March 2024');
    assert.strictEqual(chartData[1].value, 15000); // 5000 + 10000

    assert.strictEqual(chartData[2].fullLabel, 'August 2025');
    assert.strictEqual(chartData[2].value, 13000); // 15000 - 2000

    assert.strictEqual(chartData[3].fullLabel, 'November 2026');
    assert.strictEqual(chartData[3].value, 12500); // 13000 - 500
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 7: Monthly aggregation produces exactly one point per calendar month
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('7. Monthly aggregation produces exactly one point per unique calendar month with closing balance', () => {
    const multiTxnMonth = [
      { Date: '02/05/2025', 'Income/Expense': 'Income', Account: 'Axis', Amount: 10000 },
      { Date: '10/05/2025', 'Income/Expense': 'Expense', Account: 'Axis', Amount: 1500 },
      { Date: '25/05/2025', 'Income/Expense': 'Expense', Account: 'Axis', Amount: 2500 },
      { Date: '01/06/2025', 'Income/Expense': 'Expense', Account: 'Axis', Amount: 1000 },
    ];

    const chartData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: multiTxnMonth,
      acctName: 'Axis',
      isCreditCardAccount: false,
    });

    assert.strictEqual(chartData.length, 2, 'May and June only');
    assert.strictEqual(chartData[0].name, "May '25");
    assert.strictEqual(chartData[0].fullLabel, 'May 2025');
    assert.strictEqual(chartData[0].value, 6000, 'May closing balance: 10000 - 1500 - 2500 = 6000');

    assert.strictEqual(chartData[1].name, "Jun '25");
    assert.strictEqual(chartData[1].fullLabel, 'June 2025');
    assert.strictEqual(chartData[1].value, 5000, 'June closing balance: 6000 - 1000 = 5000');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 8: Missing historical months do not receive fabricated values
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('8. Missing historical months do not receive fabricated placeholder values', () => {
    const sparseTxns = [
      { Date: '15/01/2024', 'Income/Expense': 'Income', Account: 'Savings', Amount: 20000 },
      // Months between Jan 2024 and Dec 2024 have no transactions
      { Date: '10/12/2024', 'Income/Expense': 'Expense', Account: 'Savings', Amount: 5000 },
    ];

    const chartData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: sparseTxns,
      acctName: 'Savings',
      isCreditCardAccount: false,
    });

    // Exactly 2 points: Jan 2024 and Dec 2024 (no fabricated Feb, Mar, etc.)
    assert.strictEqual(chartData.length, 2);
    assert.strictEqual(chartData[0].fullLabel, 'January 2024');
    assert.strictEqual(chartData[1].fullLabel, 'December 2024');

    const monthNames = chartData.map(d => d.name);
    assert.ok(!monthNames.includes("Feb '24"), 'No fabricated February point');
    assert.ok(!monthNames.includes("Jun '24"), 'No fabricated June point');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 9: Custom and other period filters remain fully functional
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('9. Custom returns empty array; Month, Year, FY, CC Cycle return 6 data points', () => {
    const txns = [
      { Date: '10/11/2026', 'Income/Expense': 'Income', Account: 'ICICI', Amount: 40000 },
    ];

    // Custom period
    const customData = formatAccountBalanceChartData({
      period: 'Custom',
      acctTxns: txns,
      acctName: 'ICICI',
    });
    assert.strictEqual(customData.length, 0, 'Custom period must return empty array');

    // Month period
    const monthData = formatAccountBalanceChartData({
      period: 'Month',
      acctTxns: txns,
      acctName: 'ICICI',
      viewYear: 2026,
      viewMonth: 10, // Nov
    });
    assert.strictEqual(monthData.length, 6, 'Month period returns 6-month trend');

    // Year period
    const yearData = formatAccountBalanceChartData({
      period: 'Year',
      acctTxns: txns,
      acctName: 'ICICI',
      viewYear: 2026,
    });
    assert.strictEqual(yearData.length, 6, 'Year period returns 6-year trend');

    // FY period
    const fyData = formatAccountBalanceChartData({
      period: 'FY',
      acctTxns: txns,
      acctName: 'ICICI',
      viewFY: 2026,
    });
    assert.strictEqual(fyData.length, 6, 'FY period returns 6-FY trend');

    // CC Cycle period
    const ccData = formatAccountBalanceChartData({
      period: 'CC Cycle',
      acctTxns: txns,
      acctName: 'ICICI',
      isCreditCardAccount: true,
      now: new Date(2026, 10, 15),
    });
    assert.strictEqual(ccData.length, 6, 'CC Cycle period returns 6-cycle trend');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 10: Empty history and zero-balance cases are handled gracefully
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('10. Empty history and zero-balance cases are handled gracefully', () => {
    const emptyData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: [],
      acctName: 'Empty Account',
    });
    assert.strictEqual(emptyData.length, 0, 'Empty transactions list returns empty array');

    const nullTxnsData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: null,
      acctName: 'Null Account',
    });
    assert.strictEqual(nullTxnsData.length, 0, 'Null transactions list returns empty array');

    // Zero balance transaction
    const zeroTxns = [
      { Date: '01/01/2026', 'Income/Expense': 'Expense', Account: 'ICICI CC', Amount: 0 },
    ];
    const zeroChartData = formatAccountBalanceChartData({
      period: 'All',
      acctTxns: zeroTxns,
      acctName: 'ICICI CC',
      isCreditCardAccount: true,
    });
    assert.strictEqual(zeroChartData.length, 1);
    assert.strictEqual(zeroChartData[0].value, 0, 'Zero balance maps to 0');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 11: Chart Titles and Tooltips
  // ─────────────────────────────────────────────────────────────────────────────
  await t.test('11. Chart titles reflect Outstanding Balance for Credit Cards and Balance for Banks', () => {
    // Verify chartTitle logic in Accounts.jsx
    assert.ok(
      acctContent.includes("isCreditCardAccount ? 'Historical Outstanding Balance Trend' : 'Historical Balance Trend'"),
      'Historical Outstanding Balance Trend title for CCs, Historical Balance Trend for banks'
    );
    assert.ok(
      acctContent.includes("isCreditCardAccount ? '6-Year Outstanding Balance Trend' : '6-Year Balance Trend'"),
      '6-Year title adapts to credit card vs bank'
    );
    assert.ok(
      acctContent.includes("isCreditCardAccount ? '6-FY Outstanding Balance Trend' : '6-FY Balance Trend'"),
      '6-FY title adapts to credit card vs bank'
    );
    assert.ok(
      acctContent.includes("isCreditCardAccount ? '6-Month Outstanding Balance Trend' : '6-Month Balance Trend'"),
      '6-Month title adapts to credit card vs bank'
    );
    assert.ok(
      acctContent.includes("formatter={v => [formatINR(v), isCreditCardAccount ? 'Outstanding Balance' : 'Balance']}"),
      'Tooltip displays Outstanding Balance for credit cards'
    );
  });
});
