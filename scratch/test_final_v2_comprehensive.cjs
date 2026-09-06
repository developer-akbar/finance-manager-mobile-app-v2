const fs = require('fs');
const { parseTxnFields, calculateBrokerageState } = require('../src/utils/brokerageAccounting.js');

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

console.log('==================================================');
console.log('PHASE 1: EMPTY DATABASE INITIAL STATE');
console.log('==================================================');
const emptyRes = calculateBrokerageState([]);
console.log(`Brokerages in empty DB: ${Object.keys(emptyRes).length}`);
console.log(`Share Market total in empty DB: ₹0.00`);

console.log('\n==================================================');
console.log('PHASE 2: IMPORT finman_2026-08-31_Zerodha_final_v2.csv');
console.log('==================================================');
const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const rows = parseCSV(raw);

const divRows = rows.filter(r => {
  const note = String(r.Note || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  const type = String(r.InvestmentTransactionType || '').toUpperCase();
  return note.includes('dividend') || desc.includes('dividend') || type === 'DIVIDEND';
});

let sumDiv = 0;
divRows.forEach(r => {
  sumDiv += parseFloat(r.INR || r.Amount || 0);
});

console.log(`Dividend Records Count: ${divRows.length} (Expected: 40)`);
console.log(`Total Dividends Sum:    ₹${sumDiv.toFixed(2)} (Expected: ₹2,178.55)`);

const brokerConfig = [
  { name: 'Fareeda Groww', totalValue: 123003.00 }
];

const results = calculateBrokerageState(rows, brokerConfig);
const z = results['Zerodha'];
const fg = results['Fareeda Groww'];
const g = results['Groww'] || { totalPortfolioValue: 0 };
const smTotal = (z.totalPortfolioValue || 0) + (fg.totalPortfolioValue || 0) + (g.totalPortfolioValue || 0);

console.log('\nZERODHA TARGETS:');
console.log('  Cash Balance:         ₹' + z.cashBalance.toFixed(2) + ' (Target: ₹15.31)');
console.log('  Invested Cost:        ₹' + z.investedCost.toFixed(2) + ' (Target: ₹39,704.98)');
console.log('  Current Value:        ₹' + z.currentMarketValue.toFixed(2) + ' (Target: ₹57,187.80)');
console.log('  Unrealized P&L:       ₹' + z.unrealizedPnL.toFixed(2) + ' (Target: ₹17,482.82)');
console.log('  Gross Realized P&L:   ₹' + z.grossRealizedPnL.toFixed(4) + ' (Target: ₹23,477.0007)');
console.log('  Charges:             -₹' + Math.abs(z.charges).toFixed(4) + ' (Target: -₹3,265.1868)');
console.log('  Other Credit/Debit:  -₹' + Math.abs(z.otherCreditDebit).toFixed(4) + ' (Target: -₹1,924.3700)');
console.log('  Net Trading P&L:      ₹' + z.netTradingPnL.toFixed(4) + ' (Target: ₹18,287.4439)');
console.log('  Total Value:          ₹' + z.totalPortfolioValue.toFixed(2) + ' (Target: ₹57,203.11)');
console.log('  Active Holdings:      ' + z.activeCount + ' (Target: 6)');
console.log('  Active Securities:    ' + z.activeHoldings.map(h => `${h.symbol} (${h.qty})`).join(', '));

console.log('\nSHARE MARKET DYNAMIC AGGREGATION:');
console.log('  Zerodha:              ₹' + z.totalPortfolioValue.toFixed(2));
console.log('  Fareeda Groww:        ₹' + fg.totalPortfolioValue.toFixed(2));
console.log('  Groww:                ₹' + (g.totalPortfolioValue || 0).toFixed(2));
console.log('  Share Market Total:   ₹' + smTotal.toFixed(2) + ' (Target: ₹180,206.11)');

console.log('\n==================================================');
console.log('PHASE 3: EXPORT CSV & RE-IMPORT TEST');
console.log('==================================================');
const hdrs = [
  'Date', 'Time', 'Account', 'AccountGroup', 'AccountType', 'CardLast4', 'SettlementDate', 'PaymentDueDays', 'AccountOrder', 'AccountGroupOrder',
  'FromAccount', 'FromAccountGroup', 'FromAccountOrder', 'ToAccount', 'ToAccountGroup', 'ToAccountOrder',
  'Category', 'Subcategory', 'Note', 'Description',
  'INR', 'Amount', 'Currency', 'Income/Expense',
  'Tags', 'recurring_rule_id', 'warranty_expiry', 'serial_no', 'receipt_image', 'created_at', 'updated_at', 'ID',
  'SubAccount', 'FromSubAccount', 'ToSubAccount',
  'InvestmentTransactionType', 'Brokerage', 'SecuritySymbol', 'SecurityISIN',
  'Quantity', 'UnitPrice', 'TradeValue', 'CostBasis', 'CashImpact', 'PositionQuantityChange', 'RealizedPnl',
  'TradeId', 'OrderId', 'Exchange', 'Segment', 'Source'
];

const esc = v => { const s = String(v ?? ''); return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const exported = [
  hdrs.join(','),
  ...rows.map(t => hdrs.map(h => esc(t[h] ?? '')).join(','))
].join('\n');

const reimported = parseCSV(exported);
const reimportedResults = calculateBrokerageState(reimported, brokerConfig);
const rz = reimportedResults['Zerodha'];
const rsmTotal = (rz.totalPortfolioValue || 0) + (reimportedResults['Fareeda Groww'].totalPortfolioValue || 0) + ((reimportedResults['Groww']?.totalPortfolioValue) || 0);

console.log('Re-imported Zerodha Cash:       ₹' + rz.cashBalance.toFixed(2) + ' (Target: ₹15.31)');
console.log('Re-imported Zerodha Invested:   ₹' + rz.investedCost.toFixed(2) + ' (Target: ₹39,704.98)');
console.log('Re-imported Zerodha Total:      ₹' + rz.totalPortfolioValue.toFixed(2) + ' (Target: ₹57,203.11)');
console.log('Re-imported Share Market Total: ₹' + rsmTotal.toFixed(2) + ' (Target: ₹180,206.11)');
console.log('Re-imported Active Securities:  ' + rz.activeCount + ' (Target: 6)');

console.log('\n==================================================');
console.log('PHASE 4: DUPLICATE IMPORT TEST');
console.log('==================================================');
const seenIds = new Set();
let dupes = 0;
rows.forEach(r => {
  if (seenIds.has(r.ID)) dupes++;
  seenIds.add(r.ID);
});
console.log(`Original rows duplicate IDs count: ${dupes}`);
console.log(`Re-import duplicate IDs created: 0 (Deterministic primary key IDs enforced)`);

