const fs = require('fs');

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

  if (records.length < 2) return { headers: [], rows: [] };
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
  return { headers, rows };
}

const v3 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v3.csv', 'utf8'));

// CAS types
const casTypes = {};
v3.rows.filter(r => r.Source === 'CAMS_CAS').forEach(r => {
  const t = r.InvestmentTransactionType || 'NONE';
  casTypes[t] = (casTypes[t] || 0) + 1;
});

console.log('CAS Types:', casTypes);

// Zerodha records
const zerodhaRows = v3.rows.filter(r => (r.Account === 'Share Market' || r.FromAccount === 'Share Market' || r.ToAccount === 'Share Market') && (r.Brokerage === 'Zerodha' || r.Source === 'Zerodha' || r.Category === 'Equity' || r.InvestmentTransactionType));
console.log('Zerodha Total Rows:', zerodhaRows.length);

// Legacy adjustments total amount
const adjRows = v3.rows.filter(r => r.AccountingClassification === 'LEGACY_BOOKKEEPING_ADJUSTMENT');
const adjAmt = adjRows.reduce((sum, r) => sum + parseFloat(r.INR || r.Amount || 0), 0);
console.log('Legacy Adjustments:', adjRows.length, 'Total Amount: ₹' + adjAmt.toFixed(2));

// External family investment total amount
const famRows = v3.rows.filter(r => r.AccountingClassification === 'EXTERNAL_FAMILY_INVESTMENT');
const famAmt = famRows.reduce((sum, r) => sum + parseFloat(r.INR || r.Amount || 0), 0);
console.log('External Family:', famRows.length, 'Total Amount: ₹' + famAmt.toFixed(2));

// Zero value tracking total count
const zeroRows = v3.rows.filter(r => r.AccountingClassification === 'ZERO_VALUE_TRACKING');
console.log('Zero Value Tracking Count:', zeroRows.length);

