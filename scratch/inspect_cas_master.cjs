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

const masterRaw = fs.readFileSync('finman_2026-08-31_CAS_All_MF_merged_master_v2.csv', 'utf8');
const allRows = parseCSV(masterRaw);

console.log('Total rows in finman_2026-08-31_CAS_All_MF_merged_master_v2.csv:', allRows.length);

const existingRows = allRows.slice(0, 28786);
const casRows = allRows.slice(28786);

console.log('Existing FinMan rows count:', existingRows.length);
console.log('Appended CAS rows count:', casRows.length);

// Let's inspect the CAS rows structure
console.log('\n--- FIRST 5 CAS ROWS ---');
casRows.slice(0, 5).forEach((r, i) => console.log(`[${i+1}] Date=${r.Date} | Type=${r.InvestmentTransactionType} | Scheme=${r.SecuritySymbol||r.SecurityName||r.Note} | ISIN=${r.SecurityISIN} | Folio=${r.FolioNumber||r.Folio} | Units=${r.Quantity} | NAV=${r.UnitPrice||r.NAV} | Val=${r.TradeValue||r.INR}`));

console.log('\n--- TYPES OF CAS ROWS ---');
const casTypes = {};
casRows.forEach(r => {
  const t = r.InvestmentTransactionType || r.Type || '(blank)';
  casTypes[t] = (casTypes[t] || 0) + 1;
});
console.log(casTypes);

// Also inspect active holdings file if exists
if (fs.existsSync('finman_CAS_MF_active_holdings_2026-08-31_v2.csv')) {
  const actRaw = fs.readFileSync('finman_CAS_MF_active_holdings_2026-08-31_v2.csv', 'utf8');
  const actRows = parseCSV(actRaw);
  console.log('\nActive Holdings from CAS count:', actRows.length);
  actRows.forEach((r, i) => {
    console.log(` [${i+1}] Scheme=${r.Scheme || r.SecuritySymbol} | ISIN=${r.ISIN || r.SecurityISIN} | Folio=${r.Folio} | Units=${r.Units || r.Quantity} | Cost=${r.CostValue || r.InvestedCost} | MktVal=${r.CurrentMarketValue || r.CurrentValue}`);
  });
}

