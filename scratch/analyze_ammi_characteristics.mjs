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

const file = fs.existsSync('scratch/finman_reconstructed_master_preview_v4_2.csv')
  ? 'scratch/finman_reconstructed_master_preview_v4_2.csv'
  : 'scratch/finman_reconstructed_master_preview_v4.csv';

const allRows = parseCSV(fs.readFileSync(file, 'utf8'));

const ammiRows = allRows.filter(r => {
  const toAcct = r.ToAccount;
  const fromAcct = r.Account || r.FromAccount;
  if (toAcct !== 'Liquid Mutual Funds' && fromAcct !== 'Liquid Mutual Funds') return false;
  return resolveInvestmentSubAccount(r, 'Liquid Mutual Funds') === 'Ammi Groww';
});

console.log('--- Historical Ammi Rows Summary ---');
console.log('Total count:', ammiRows.length);

const types = {};
const subAccounts = {};
const toSubAccounts = {};
const fromSubAccounts = {};
const brokerages = {};
const invTypes = {};
const accounts = {};
const fromAccounts = {};
const toAccounts = {};

ammiRows.forEach(r => {
  types[r['Income/Expense']] = (types[r['Income/Expense']] || 0) + 1;
  subAccounts[r.SubAccount || '(empty)'] = (subAccounts[r.SubAccount || '(empty)'] || 0) + 1;
  toSubAccounts[r.ToSubAccount || '(empty)'] = (toSubAccounts[r.ToSubAccount || '(empty)'] || 0) + 1;
  fromSubAccounts[r.FromSubAccount || '(empty)'] = (fromSubAccounts[r.FromSubAccount || '(empty)'] || 0) + 1;
  brokerages[r.Brokerage || '(empty)'] = (brokerages[r.Brokerage || '(empty)'] || 0) + 1;
  invTypes[r.InvestmentTransactionType || '(empty)'] = (invTypes[r.InvestmentTransactionType || '(empty)'] || 0) + 1;
  accounts[r.Account || '(empty)'] = (accounts[r.Account || '(empty)'] || 0) + 1;
  fromAccounts[r.FromAccount || '(empty)'] = (fromAccounts[r.FromAccount || '(empty)'] || 0) + 1;
  toAccounts[r.ToAccount || '(empty)'] = (toAccounts[r.ToAccount || '(empty)'] || 0) + 1;
});

console.log('Types:', types);
console.log('SubAccount:', subAccounts);
console.log('ToSubAccount:', toSubAccounts);
console.log('FromSubAccount:', fromSubAccounts);
console.log('Brokerage:', brokerages);
console.log('InvestmentTransactionType:', invTypes);
console.log('Account:', accounts);
console.log('FromAccount:', fromAccounts);
console.log('ToAccount:', toAccounts);
