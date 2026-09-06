const fs = require('fs');

const filename = 'finman_2026-08-31_CAS_All_MF_merged_master_v2.csv';
if (!fs.existsSync(filename)) {
  console.log(`File ${filename} not found! Listing CSV files in workspace:`);
  fs.readdirSync('.').filter(f => f.endsWith('.csv')).forEach(f => console.log(' - ' + f));
  process.exit(1);
}

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return rows;
}

const raw = fs.readFileSync(filename, 'utf8');
const rows = parseCSV(raw);

console.log(`Total rows in ${filename}:`, rows.length);

// Let's inspect the headers
const headers = Object.keys(rows[0] || {});
console.log('Headers:', headers.join(', '));

// Find the CAS rows
const casRows = rows.filter(r => {
  const src = (r.Source || '').toLowerCase();
  const invType = (r.InvestmentTransactionType || '').toLowerCase();
  const isin = (r.SecurityISIN || '').toLowerCase();
  const folio = (r.FolioNumber || r.Folio || '').toLowerCase();
  return src.includes('cas') || isin.startsWith('inf') || folio.length > 0 || (r.Brokerage && r.Brokerage.toLowerCase().includes('cams'));
});

console.log('Detected CAS rows count:', casRows.length);

console.log('\n--- SAMPLE FIRST 5 CAS ROWS ---');
casRows.slice(0, 5).forEach((r, idx) => {
  console.log(`Row #${idx + 1}:`, JSON.stringify(r, null, 2));
});

console.log('\n--- SAMPLE LAST 5 CAS ROWS ---');
casRows.slice(-5).forEach((r, idx) => {
  console.log(`Row #${casRows.length - 5 + idx + 1}:`, JSON.stringify(r, null, 2));
});

// Check fields in CAS rows
console.log('\n--- CAS ROWS FIELD COMPLETENESS AUDIT ---');
let blankAccount = 0;
let blankFromAccount = 0;
let blankToAccount = 0;
let blankIncomeExpense = 0;
let blankDate = 0;
let blankAmount = 0;
let blankType = 0;
let blankISIN = 0;
let blankUnits = 0;
let blankNAV = 0;

casRows.forEach(r => {
  if (!r.Account) blankAccount++;
  if (!r.FromAccount) blankFromAccount++;
  if (!r.ToAccount) blankToAccount++;
  if (!r['Income/Expense']) blankIncomeExpense++;
  if (!r.Date) blankDate++;
  if (!r.INR && !r.Amount && !r.TradeValue) blankAmount++;
  if (!r.InvestmentTransactionType) blankType++;
  if (!r.SecurityISIN) blankISIN++;
  if (!r.Quantity) blankUnits++;
  if (!r.UnitPrice && !r.NAV) blankNAV++;
});

console.log({
  totalCasRows: casRows.length,
  blankAccount,
  blankFromAccount,
  blankToAccount,
  blankIncomeExpense,
  blankDate,
  blankAmount,
  blankType,
  blankISIN,
  blankUnits,
  blankNAV
});

