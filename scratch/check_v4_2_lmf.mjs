import fs from 'fs';
import { resolveInvestmentSubAccount } from '../src/utils/brokerageAccounting.js';

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
    const values = [];
    let match;
    while ((match = regex.exec(lines[i])) !== null) {
      if (match.index === regex.lastIndex) regex.lastIndex++;
      values.push(match[1] !== undefined ? match[1] : match[2]);
    }
    if (values.length > headers.length) values.length = headers.length;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (values[idx] || '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

const file = 'scratch/finman_reconstructed_master_preview_v4_2.csv';
const rows = parseCSV(fs.readFileSync(file, 'utf8'));

console.log('Total rows in v4_2:', rows.length);

const lmfRows = rows.filter(r => 
  r.Account === 'Liquid Mutual Funds' ||
  r.FromAccount === 'Liquid Mutual Funds' ||
  r.ToAccount === 'Liquid Mutual Funds' ||
  r.Category === 'Liquid Mutual Funds' ||
  r.InvestmentAccount === 'Liquid Mutual Funds'
);

console.log('LMF rows in v4_2:', lmfRows.length);

// Check subaccounts and balances
const subBals = {};
const subCounts = {};

lmfRows.forEach(r => {
  const sub = resolveInvestmentSubAccount(r, 'Liquid Mutual Funds');
  const amt = parseFloat(r.INR || r.Amount || 0);
  const type = r['Income/Expense'];
  const fromAcct = r.FromAccount || r.Account;
  const dest = r.ToAccount;

  subCounts[sub] = (subCounts[sub] || 0) + 1;
  if (!subBals[sub]) subBals[sub] = 0;

  if (type === 'Transfer-Out') {
    if (dest === 'Liquid Mutual Funds') subBals[sub] += amt;
    if (fromAcct === 'Liquid Mutual Funds') subBals[sub] -= amt;
  } else if (type === 'Income') {
    subBals[sub] += amt;
  } else if (type === 'Expense') {
    subBals[sub] -= amt;
  }
});

console.log('Sub counts in v4_2:', subCounts);
console.log('Sub balances in v4_2:', subBals);
