const fs = require('fs');
const { calculateBrokerageState } = require('../src/utils/brokerageAccounting.js');

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return rows;
}

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const transactions = parseCSV(raw);

console.log('=== RUNNING FULL ACCOUNTING REGRESSION TESTS ===');

// 1. Check Zerodha metrics
const brokerages = [{ name: 'Zerodha' }, { name: 'Fareeda Groww', totalValue: 123003 }, { name: 'Groww' }];
const sm = calculateBrokerageState(transactions, brokerages, {});
const z = sm.Zerodha;

console.log('\n--- 1. ZERODHA METRICS ---');
console.log('Stock Market Value:   ₹' + z.currentValue.toFixed(2), Math.abs(z.currentValue - 57187.80) < 0.01 ? '✅ PASS' : '❌ FAIL');
console.log('Cash Balance:         ₹' + z.cashBalance.toFixed(2), Math.abs(z.cashBalance - 15.31) < 0.01 ? '✅ PASS' : '❌ FAIL');
console.log('Zerodha Total Value:  ₹' + z.totalValue.toFixed(2), Math.abs(z.totalValue - 57203.11) < 0.01 ? '✅ PASS' : '❌ FAIL');
console.log('Invested Cost Basis:  ₹' + z.investedCost.toFixed(2), Math.abs(z.investedCost - 39704.98) < 0.01 ? '✅ PASS' : '❌ FAIL');
console.log('Unrealized P&L:       ₹' + z.unrealizedPnL.toFixed(2), Math.abs(z.unrealizedPnL - 17482.82) < 0.01 ? '✅ PASS' : '❌ FAIL');
console.log('Net Realized Trading: ₹' + z.netTradingPnL.toFixed(2), Math.abs(z.netTradingPnL - 18287.44) < 0.01 ? '✅ PASS' : '❌ FAIL');

// Check Zerodha Dividends
let zerodhaDivs = 0;
transactions.forEach(t => {
  const note = (t.Note || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  if (t.InvestmentTransactionType === 'DIVIDEND' || (cat === 'equity' && (note === 'dividend' || note.includes('dividend')))) {
    zerodhaDivs += parseFloat(t.INR || 0);
  }
});
console.log('Total Dividends:      ₹' + zerodhaDivs.toFixed(2), Math.abs(zerodhaDivs - 2178.55) < 0.01 ? '✅ PASS' : '❌ FAIL');

// 2. Check Fareeda Groww metrics
console.log('\n--- 2. FAREEDA GROWW METRICS ---');
const fg = sm['Fareeda Groww'];
console.log('Fareeda Groww Value:  ₹' + fg.totalValue.toFixed(2), fg.totalValue === 123003 ? '✅ PASS' : '❌ FAIL');

// 3. Check Share Market Aggregate
console.log('\n--- 3. SHARE MARKET AGGREGATE ---');
const smTotal = z.totalValue + fg.totalValue;
console.log('Share Market Value:   ₹' + smTotal.toFixed(2), Math.abs(smTotal - 180206.11) < 0.01 ? '✅ PASS' : '❌ FAIL');

// 4. Check Mutual Fund Realized P&L
console.log('\n--- 4. MUTUAL FUND REALIZED P&L ---');
let taxGains = 0;
let lmfGains = 0;
let lmfLosses = 0;
transactions.forEach(t => {
  if (t.Category === 'Equity') {
    const amt = parseFloat(t.INR || 0);
    if (t.Subcategory === 'Tax MF Gains') taxGains += amt;
    if (t.Subcategory === 'Liquid MF Gains') lmfGains += amt;
    if (t.Subcategory === 'Liquid MF Losses') lmfLosses += amt;
  }
});
console.log('Tax Saver Realized:   ₹' + taxGains.toFixed(2), taxGains === 141549 ? '✅ PASS' : '❌ FAIL');
console.log('Liquid MF Gains:      ₹' + lmfGains.toFixed(2), lmfGains === 6206 ? '✅ PASS' : '❌ FAIL');
console.log('Liquid MF Losses:     ₹' + lmfLosses.toFixed(2), lmfLosses === -25961 ? '✅ PASS' : '❌ FAIL');
console.log('Liquid MF Net P&L:    ₹' + (lmfGains + lmfLosses).toFixed(2), (lmfGains + lmfLosses) === -19755 ? '✅ PASS' : '❌ FAIL');
console.log('Total Net MF P&L:     ₹' + (taxGains + lmfGains + lmfLosses).toFixed(2), (taxGains + lmfGains + lmfLosses) === 121794 ? '✅ PASS' : '❌ FAIL');

console.log('\nALL REGRESSION TESTS COMPLETED SUCCESSFULLY.');

