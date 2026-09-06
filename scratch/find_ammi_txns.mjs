import fs from 'fs';
import { resolveInvestmentSubAccount } from '../src/utils/brokerageAccounting.js';

const lines = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8').split(/\r?\n/).filter(Boolean);
const headers = lines[0].split(',').map(h => h.trim());

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',');
  const r = {};
  headers.forEach((h, idx) => r[h] = (parts[idx] || '').trim());
  rows.push(r);
}

const ammiRows = rows.filter(r => {
  const combined = `${r.Note || ''} ${r.Description || ''} ${r.SubAccount || ''} ${r.Category || ''}`.toLowerCase();
  return combined.includes('ammi');
});

console.log('Total Ammi rows:', ammiRows.length);
let sum = 0;
ammiRows.forEach(r => {
  const amt = parseFloat(r.INR || r.Amount || 0);
  const type = r['Income/Expense'];
  console.log(r.Date, r.Account, r.FromAccount, '->', r.ToAccount, r.Category, r.Amount, r.Note, resolveInvestmentSubAccount(r, 'Liquid Mutual Funds'));
});
