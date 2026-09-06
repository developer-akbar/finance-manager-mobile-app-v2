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

const ammiRows = rows.filter(r => {
  const toAcct = r.ToAccount;
  const fromAcct = r.Account || r.FromAccount;
  if (toAcct !== 'Liquid Mutual Funds' && fromAcct !== 'Liquid Mutual Funds') return false;
  return resolveInvestmentSubAccount(r, 'Liquid Mutual Funds') === 'Ammi Groww';
});

ammiRows.forEach(r => {
  console.log(r.Date, r.INR, r['Income/Expense'], r.FromAccount, '->', r.ToAccount, r.Note);
});
