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

const existingRows = allRows.slice(0, 28786);
const casRows = allRows.slice(28786);

console.log('Total CAS rows count:', casRows.length);

// 1. Audit Types in CAS Rows
const typeBreakdown = {};
casRows.forEach((r, idx) => {
  const t = r.InvestmentTransactionType;
  typeBreakdown[t] = (typeBreakdown[t] || 0) + 1;
});
console.log('Type Breakdown of 163 CAS Rows:', typeBreakdown);

// 2. Audit Redeemed Schemes in CAS
const redeemedSchemesRaw = fs.readFileSync('finman_CAS_MF_redeemed_schemes_2026-08-31_v2.csv', 'utf8');
const redeemedRows = parseCSV(redeemedSchemesRaw);
console.log('\nRedeemed Schemes File Rows count:', redeemedRows.length);
redeemedRows.forEach(r => console.log(JSON.stringify(r)));

// 3. Let's compare CAS Realized P&L vs FinMan recorded P&L for every redeemed scheme
const sellRows = casRows.filter(r => r.InvestmentTransactionType === 'SELL');
console.log('\nTotal SELL rows in CAS:', sellRows.length);
sellRows.forEach((s, i) => {
  console.log(`[SELL ${i+1}] Date: ${s.Date} | Scheme: ${s.SecuritySymbol} | ISIN: ${s.SecurityISIN} | Units: ${s.Quantity} | NAV: ${s.UnitPrice} | TradeValue: ${s.TradeValue} | CostBasis: ${s.CostBasis} | RealizedPnl: ${s.RealizedPnl}`);
});

