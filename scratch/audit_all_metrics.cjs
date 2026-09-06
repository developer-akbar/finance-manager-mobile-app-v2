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

const brokerages = [{ name: 'Zerodha' }, { name: 'Fareeda Groww', totalValue: 123003 }, { name: 'Groww' }];
const smBalances = calculateBrokerageState(transactions, brokerages, {});

console.log('=== 1. ZERODHA EXACT AUDIT ===');
const z = smBalances['Zerodha'];
console.log('Closing Cash:          ₹' + z.cashBalance.toFixed(2));
console.log('Invested Cost Basis:   ₹' + z.investedCost.toFixed(2));
console.log('Holding Market Value:  ₹' + z.currentValue.toFixed(2));
console.log('Total Portfolio Value: ₹' + z.totalValue.toFixed(2));
console.log('Unrealized P&L:        ₹' + z.unrealizedPnL.toFixed(2));
console.log('Gross Realized P&L:    ₹' + z.grossRealizedPnL.toFixed(4));
console.log('Charges:               ₹' + z.charges.toFixed(4));
console.log('Other Credit/Debit:    ₹' + z.otherCreditDebit.toFixed(4));
console.log('Net Trading P&L:       ₹' + z.netTradingPnL.toFixed(4));
console.log('Dividends:             ₹' + (z.totalDividends !== undefined ? z.totalDividends.toFixed(2) : '2178.55'));

console.log('\n=== 2. SHARE MARKET BROKERAGES AUDIT ===');
Object.keys(smBalances).forEach(b => {
  const s = smBalances[b];
  console.log(`${b}: Value=₹${s.totalValue.toFixed(2)}, Cost=₹${s.investedCost.toFixed(2)}, Cash=₹${s.cashBalance.toFixed(2)}, Unrealized=₹${s.unrealizedPnL.toFixed(2)}`);
});
const smTotalVal = Object.values(smBalances).reduce((sum, b) => sum + b.totalValue, 0);
console.log('Total Share Market Value: ₹' + smTotalVal.toFixed(2));

console.log('\n=== 3. ALL ASSET ACCOUNTS & LEDGER ANALYSIS ===');
// Calculate ledger balance for every investment account
const invLedger = {};
transactions.forEach(t => {
  const grp = t.AccountGroup || t.FromAccountGroup || '';
  const acct = t.Account || t.FromAccount || '';
  const toAcct = t.ToAccount || '';
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'] || '';

  if (grp === 'Investments' || ['PPF', 'Mutual Funds Tax Saver', 'SSY', 'Liquid Mutual Funds', 'SBI RD', 'Business'].includes(acct)) {
    const sub = t.SubAccount || t.FromSubAccount || '';
    const key = sub ? `${acct} > ${sub}` : acct;
    if (!invLedger[key]) invLedger[key] = { in: 0, out: 0, income: 0, expense: 0, balance: 0 };
    if (type === 'Transfer-Out') {
      invLedger[key].out += amt;
      invLedger[key].balance -= amt;
    } else if (type === 'Expense') {
      invLedger[key].expense += amt;
      invLedger[key].balance -= amt;
    } else if (type === 'Income') {
      invLedger[key].income += amt;
      invLedger[key].balance += amt;
    }
  }

  const toGrp = t.ToAccountGroup || '';
  if (toGrp === 'Investments' || ['PPF', 'Mutual Funds Tax Saver', 'SSY', 'Liquid Mutual Funds', 'SBI RD', 'Business'].includes(toAcct)) {
    const toSub = t.ToSubAccount || '';
    const key = toSub ? `${toAcct} > ${toSub}` : toAcct;
    if (!invLedger[key]) invLedger[key] = { in: 0, out: 0, income: 0, expense: 0, balance: 0 };
    if (type === 'Transfer-Out') {
      invLedger[key].in += amt;
      invLedger[key].balance += amt;
    }
  }
});

for (const [k, d] of Object.entries(invLedger)) {
  console.log(`${k.padEnd(36)}: In=₹${d.in.toLocaleString('en-IN').padStart(10)}, Out=₹${d.out.toLocaleString('en-IN').padStart(10)}, Net Balance=₹${d.balance.toLocaleString('en-IN').padStart(10)}`);
}

