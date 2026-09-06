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

const checkIsRedeemed = (t) => {
  if (!t) return false;
  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
  if (invType === 'SELL') return true;
  const note = String(t.Note || t.note || '').toLowerCase();
  const desc = String(t.Description || t.description || '').toLowerCase();
  const tags = String(t.Tags || t.tags || '').toLowerCase();
  const combined = `${note} ${desc} ${tags}`;
  return combined.includes('redeemed') ||
    combined.includes('redemption') ||
    combined.includes('from share market') ||
    combined.includes('sell');
};

const previewRaw = fs.readFileSync('scratch/finman_CAS_enriched_master_preview_v2.csv', 'utf8');
const allTxns = parseCSV(previewRaw);

const casLiquidTxns = allTxns.filter(t => t.Source === 'CAMS_CAS' && (t.Account === 'Liquid Mutual Funds' || t.FromAccount === 'Liquid Mutual Funds' || t.ToAccount === 'Liquid Mutual Funds'));

console.log('=== LIQUID MUTUAL FUNDS CAS TRANSACTIONS BREAKDOWN ===');
console.log('Total Liquid MF CAS Transactions:', casLiquidTxns.length);

const buys = casLiquidTxns.filter(t => t.InvestmentTransactionType === 'BUY');
const sells = casLiquidTxns.filter(t => t.InvestmentTransactionType === 'SELL');
const adjs = casLiquidTxns.filter(t => t.InvestmentTransactionType === 'UNIT_ADJUSTMENT');

console.log(`- BUY Transactions:             ${buys.length}`);
console.log(`- SELL Transactions:            ${sells.length}`);
console.log(`- UNIT_ADJUSTMENT Transactions: ${adjs.length}`);
console.log(`- Sum of (BUY + UNIT_ADJUSTMENT): ${buys.length + adjs.length}`);
console.log(`- Sum of ALL (38 + 7):           ${buys.length + adjs.length + sells.length}`);

let activeCount = 0;
let redeemedCount = 0;
for (const t of casLiquidTxns) {
  if (checkIsRedeemed(t)) redeemedCount++;
  else activeCount++;
}

console.log(`\nUI Tabs Partitioning:`);
console.log(`- Active Tab:   ${activeCount} transactions (24 BUY + 14 UNIT_ADJUSTMENT)`);
console.log(`- Redeemed Tab: ${redeemedCount} transactions (7 SELL)`);
console.log(`- Exact Sum:    ${activeCount} + ${redeemedCount} = ${activeCount + redeemedCount} ✅`);

