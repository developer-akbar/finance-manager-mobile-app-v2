import fs from 'fs';
import { resolveInvestmentSubAccount, resolveInvestmentAccounts } from '../src/utils/brokerageAccounting.js';

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (parts[idx] || '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

const csvFile = fs.existsSync('finman_2026-08-31_Zerodha_final_v2.csv') 
  ? 'finman_2026-08-31_Zerodha_final_v2.csv' 
  : (fs.existsSync('scratch/finman_CAS_enriched_master_preview_v2.csv') 
      ? 'scratch/finman_CAS_enriched_master_preview_v2.csv' 
      : 'finman_2026-08-30_shares_data.csv');

console.log('Reading from:', csvFile);
const rows = parseCSV(fs.readFileSync(csvFile, 'utf8'));

// Filter Liquid Mutual Funds txns
const lmfTxns = rows.filter(t => 
  t.Account === 'Liquid Mutual Funds' || 
  t.FromAccount === 'Liquid Mutual Funds' || 
  t.ToAccount === 'Liquid Mutual Funds' || 
  t.InvestmentAccount === 'Liquid Mutual Funds' ||
  t.Category === 'Liquid Mutual Funds'
);

console.log('Found LMF txns:', lmfTxns.length);

const subCounts = {};
const subBalances = {};

lmfTxns.forEach(t => {
  const sub = resolveInvestmentSubAccount(t, 'Liquid Mutual Funds');
  subCounts[sub] = (subCounts[sub] || 0) + 1;

  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'];
  const fromAcct = t.FromAccount || t.Account;
  const dest = t.ToAccount;

  if (!subBalances[sub]) subBalances[sub] = 0;
  if (type === 'Transfer-Out') {
    if (dest === 'Liquid Mutual Funds') subBalances[sub] += amt;
    if (fromAcct === 'Liquid Mutual Funds') subBalances[sub] -= amt;
  } else if (type === 'Income') {
    subBalances[sub] += amt;
  } else if (type === 'Expense') {
    subBalances[sub] -= amt;
  }
});

console.log('Subaccount counts:', subCounts);
console.log('Subaccount balances:', subBalances);
