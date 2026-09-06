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

const rows = parseCSV(fs.readFileSync(file, 'utf8'));

let ammiTotal = 0;
let fareedaTotal = 0;
let akTotal = 0;
let otherTotal = 0;

rows.forEach(r => {
  const toAcct = r.ToAccount;
  const fromAcct = r.Account || r.FromAccount;
  const isDestLmf = toAcct === 'Liquid Mutual Funds';
  const isAcctLmf = fromAcct === 'Liquid Mutual Funds';

  if (!isDestLmf && !isAcctLmf) return;

  const amt = parseFloat(r.INR || r.Amount || 0);
  const type = r['Income/Expense'];
  let delta = 0;
  if (isDestLmf && type === 'Transfer-Out') delta += amt;
  if (isAcctLmf) {
    if (type === 'Income') delta += amt;
    else if (type === 'Expense') delta -= amt;
    else if (type === 'Transfer-Out') delta -= amt;
  }

  const sub = resolveInvestmentSubAccount(r, 'Liquid Mutual Funds');
  if (sub === 'Ammi Groww') ammiTotal += delta;
  else if (sub === 'Fareeda Groww') fareedaTotal += delta;
  else if (sub === 'Ak ETMoney') akTotal += delta;
  else {
    otherTotal += delta;
    console.log('Unassigned row:', r.ID, r.Date, amt, sub, r.Note);
  }
});

console.log('--- Subaccount Balances with resolveInvestmentSubAccount ---');
console.log('Ammi Groww:   ', ammiTotal);
console.log('Fareeda Groww:', fareedaTotal);
console.log('Ak ETMoney:   ', akTotal);
console.log('Other:        ', otherTotal);
console.log('Total LMF:    ', ammiTotal + fareedaTotal + akTotal + otherTotal);
