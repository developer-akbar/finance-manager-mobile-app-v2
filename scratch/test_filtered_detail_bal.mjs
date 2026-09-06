import fs from 'fs';
import { resolveInvestmentSubAccount } from '../src/utils/brokerageAccounting.js';

function parseCSV(text) {
  const records = [];
  let field = '';
  let fields = [];
  let inQ = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQ) {
      if (ch === '"' && next === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { fields.push(field); field = ''; i++; continue; }
    if (ch === '\n' || (ch === '\r' && next === '\n')) {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      if (ch === '\r') i++;
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.length > 1) records.push(fields);

  const headers = records[0].map(h => h.trim());
  const rows = [];
  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => row[h] = (rec[idx] || '').trim());
    rows.push(row);
  }
  return rows;
}

function txnAmount(t) {
  return parseFloat(t.INR || t.Amount || 0);
}

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

function isInvestmentTransactionForSubAccount(txn, parentAsset, subAccount) {
  if (!txn || !parentAsset || !subAccount) return false;
  const resolvedParent = resolveInvestmentParent(txn);
  if (resolvedParent !== parentAsset) return false;

  const resolvedPlatform = resolveInvestmentSubAccount(txn, parentAsset);
  return resolvedPlatform === subAccount;
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

const file = fs.existsSync('scratch/finman_reconstructed_master_preview_v4_2.csv')
  ? 'scratch/finman_reconstructed_master_preview_v4_2.csv'
  : 'scratch/finman_reconstructed_master_preview_v4.csv';

const allRows = parseCSV(fs.readFileSync(file, 'utf8'));

const fareedaTxns = allRows.filter(t => isInvestmentTransactionForSubAccount(t, 'Liquid Mutual Funds', 'Fareeda Groww'));
const ammiTxns = allRows.filter(t => isInvestmentTransactionForSubAccount(t, 'Liquid Mutual Funds', 'Ammi Groww'));

console.log('Fareeda filtered txns count:', fareedaTxns.length);
console.log('Fareeda computeBalance:     ', computeBalance(fareedaTxns, 'Liquid Mutual Funds'));

console.log('Ammi filtered txns count:   ', ammiTxns.length);
console.log('Ammi computeBalance:        ', computeBalance(ammiTxns, 'Liquid Mutual Funds'));
