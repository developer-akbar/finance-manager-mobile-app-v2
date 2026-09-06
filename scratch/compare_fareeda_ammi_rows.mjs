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

const fareedaRows = rows.filter(r => resolveInvestmentSubAccount(r, 'Liquid Mutual Funds') === 'Fareeda Groww');
const ammiRows = rows.filter(r => resolveInvestmentSubAccount(r, 'Liquid Mutual Funds') === 'Ammi Groww');

console.log('Fareeda rows count:', fareedaRows.length);
console.log('Ammi rows count:', ammiRows.length);

console.log('\n--- Sample Fareeda Row ---');
console.log(JSON.stringify(fareedaRows[0], null, 2));

console.log('\n--- Sample Ammi Row ---');
console.log(JSON.stringify(ammiRows[0], null, 2));

// Compare fields present in Fareeda vs Ammi
const fareedaKeys = new Set(fareedaRows.flatMap(r => Object.keys(r).filter(k => r[k])));
const ammiKeys = new Set(ammiRows.flatMap(r => Object.keys(r).filter(k => r[k])));

console.log('\nKeys populated in Fareeda but not Ammi:');
for (const k of fareedaKeys) {
  if (!ammiKeys.has(k)) console.log(' ', k);
}

console.log('\nKeys populated in Ammi but not Fareeda:');
for (const k of ammiKeys) {
  if (!fareedaKeys.has(k)) console.log(' ', k);
}
