import fs from 'fs';
import { resolveInvestmentSubAccount } from '../src/utils/brokerageAccounting.js';

function resolveInvestmentParent(txn) {
  if (!txn) return null;
  const invAcct = String(txn.InvestmentAccount || txn.investment_account || '').trim();
  const acct = String(txn.Account || txn.account || '').trim();
  const fromAcct = String(txn.FromAccount || txn.from_account || '').trim();
  const toAcct = String(txn.ToAccount || txn.to_account || '').trim();
  const cat = String(txn.Category || txn.category || '').trim();

  if (invAcct === 'Mutual Funds Tax Saver' || toAcct === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver' || fromAcct === 'Mutual Funds Tax Saver' || cat === 'Mutual Funds Tax Saver') {
    return 'Mutual Funds Tax Saver';
  }
  if (invAcct === 'Liquid Mutual Funds' || toAcct === 'Liquid Mutual Funds' || acct === 'Liquid Mutual Funds' || fromAcct === 'Liquid Mutual Funds' || cat === 'Liquid Mutual Funds') {
    return 'Liquid Mutual Funds';
  }
  if (invAcct === 'Share Market' || toAcct === 'Share Market' || acct === 'Share Market' || fromAcct === 'Share Market' || cat === 'Share Market' || cat === 'Equity') {
    return 'Share Market';
  }
  return null;
}

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

function txnAmount(t) {
  return parseFloat(t.INR || t.Amount || 0);
}

function computeBalance(txns, acctName) {
  let bal = 0;
  for (const t of txns) {
    const amt = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = t.Account || t.FromAccount || '';
    const dest = t.ToAccount || '';

    if (type === 'Income') { if (acct === acctName) bal += amt; }
    else if (type === 'Expense') { if (acct === acctName) bal -= amt; }
    else if (type === 'Transfer-Out') {
      if (acct === acctName) bal -= amt;
      if (dest === acctName) bal += amt;
    }
  }
  return bal;
}

const file = 'scratch/finman_reconstructed_master_preview_v4_2.csv';
const allTxns = parseCSV(fs.readFileSync(file, 'utf8'));

// Filter for Liquid Mutual Funds -> Ammi Groww
const ammiTxns = allTxns.filter(t => {
  const resolvedParent = resolveInvestmentParent(t);
  if (resolvedParent !== 'Liquid Mutual Funds') return false;
  const resolvedPlatform = resolveInvestmentSubAccount(t, 'Liquid Mutual Funds');
  return resolvedPlatform === 'Ammi Groww';
});

console.log('Ammi Groww txns count:', ammiTxns.length);
const ammiBal = computeBalance(ammiTxns, 'Liquid Mutual Funds');
console.log('computeBalance on Ammi Groww txns:', ammiBal);

// Filter for Liquid Mutual Funds -> Fareeda Groww
const fareedaTxns = allTxns.filter(t => {
  const resolvedParent = resolveInvestmentParent(t);
  if (resolvedParent !== 'Liquid Mutual Funds') return false;
  const resolvedPlatform = resolveInvestmentSubAccount(t, 'Liquid Mutual Funds');
  return resolvedPlatform === 'Fareeda Groww';
});

console.log('Fareeda Groww txns count:', fareedaTxns.length);
const fareedaBal = computeBalance(fareedaTxns, 'Liquid Mutual Funds');
console.log('computeBalance on Fareeda Groww txns:', fareedaBal);
