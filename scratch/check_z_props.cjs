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
const sm = calculateBrokerageState(transactions, brokerages, {});
const z = sm.Zerodha;

console.log('Zerodha Object:', JSON.stringify(z, null, 2));

console.log('\nFloating point exact values:');
console.log('currentValue:', z.currentValue, Math.abs(z.currentValue - 57187.80) < 0.001);
console.log('cashBalance:', z.cashBalance, Math.abs(z.cashBalance - 15.31) < 0.001);
console.log('totalValue:', z.totalValue, Math.abs(z.totalValue - 57203.11) < 0.001);
console.log('investedCost:', z.investedCost, Math.abs(z.investedCost - 39704.98) < 0.001);
console.log('unrealizedPnL:', z.unrealizedPnL, Math.abs(z.unrealizedPnL - 17482.82) < 0.001);
console.log('netTradingPnL:', z.netTradingPnL, Math.abs(z.netTradingPnL - 18287.4439) < 0.001);

