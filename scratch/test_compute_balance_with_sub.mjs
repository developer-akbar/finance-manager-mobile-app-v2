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

function computeBalance(txns, acctName, subAccountName = null) {
  if (subAccountName) {
    let bal = 0;
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());

    for (const t of txns) {
      const amt = txnAmount(t);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = String(t.Account || '').trim();
      const fromAcct = String(t.FromAccount || t.Account || '').trim();
      const dest = String(t.ToAccount || '').trim();

      const sub = String(t.SubAccount || t.sub_account || '').trim();
      const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
      const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

      const isFromInv = fromAcct === 'Mutual Funds Tax Saver' || fromAcct === 'Liquid Mutual Funds' || fromAcct === 'Share Market';
      const isDestInv = dest === 'Mutual Funds Tax Saver' || dest === 'Liquid Mutual Funds' || dest === 'Share Market';
      const isAcctInv = acct === 'Mutual Funds Tax Saver' || acct === 'Liquid Mutual Funds' || acct === 'Share Market';

      const resolvedFromSub = (fromSub && fromSub !== 'Default') ? fromSub : (isFromInv ? resolveInvestmentSubAccount(t, fromAcct) : (sub && sub !== 'Default' ? sub : ''));
      const resolvedToSub = (toSub && toSub !== 'Default') ? toSub : (isDestInv ? resolveInvestmentSubAccount(t, dest) : (sub && sub !== 'Default' ? sub : ''));
      const resolvedAcctSub = (sub && sub !== 'Default') ? sub : (isAcctInv ? resolveInvestmentSubAccount(t, acct) : '');

      if (type === 'Income') {
        const targetAcct = dest || acct;
        const targetSub = dest ? resolvedToSub : resolvedAcctSub;
        if (targetAcct === acctName && targetSub === subAccountName) {
          bal += amt;
        }
      } else if (type === 'Expense') {
        const targetAcct = fromAcct || acct;
        const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
        if (targetAcct === acctName && targetSub === subAccountName) {
          bal -= amt;
        }
      } else if (type === 'Transfer-Out') {
        if (fromAcct === acctName && resolvedFromSub === subAccountName) {
          bal -= amt;
        }
        if (dest === acctName && resolvedToSub === subAccountName) {
          bal += amt;
        }
      }
    }
    return bal;
  }

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

const ammiBal = computeBalance(allRows, 'Liquid Mutual Funds', 'Ammi Groww');
const fareedaBal = computeBalance(allRows, 'Liquid Mutual Funds', 'Fareeda Groww');

console.log('Ammi Groww computeBalance:   ', ammiBal);
console.log('Fareeda Groww computeBalance:', fareedaBal);
