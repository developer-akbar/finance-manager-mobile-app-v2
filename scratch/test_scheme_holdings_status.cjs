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

const previewRaw = fs.readFileSync('scratch/finman_CAS_enriched_master_preview_v2.csv', 'utf8');
const allTxns = parseCSV(previewRaw);

// Test grouping by Scheme / Fund Symbol within each Platform
const casTxns = allTxns.filter(t => t.Source === 'CAMS_CAS');

const schemes = {};
for (const t of casTxns) {
  const sym = t.SecuritySymbol;
  const parent = t.Account || t.FromAccount || t.ToAccount;
  const key = `${parent} | ${sym}`;
  if (!schemes[key]) {
    schemes[key] = {
      parent,
      symbol: sym,
      isin: t.SecurityISIN,
      txns: [],
      netUnits: 0,
      totalInvested: 0,
      totalProceeds: 0,
      realizedPnl: 0,
      unitAdjs: 0
    };
  }
  schemes[key].txns.push(t);
  const qty = parseFloat(t.Quantity || t.PositionQuantityChange || 0);
  const type = t.InvestmentTransactionType;
  const tradeVal = parseFloat(t.TradeValue || t.CostBasis || t.INR || 0);
  const pnl = parseFloat(t.RealizedPnl || 0);

  if (type === 'BUY') {
    schemes[key].netUnits += qty;
    schemes[key].totalInvested += tradeVal;
  } else if (type === 'SELL') {
    schemes[key].netUnits += qty; // qty is negative on SELL
    schemes[key].totalProceeds += tradeVal;
    schemes[key].realizedPnl += pnl;
  } else if (type === 'UNIT_ADJUSTMENT') {
    schemes[key].netUnits += qty;
    schemes[key].unitAdjs++;
  }
}

console.log('=== CAS SCHEMES NET POSITION & HOLDING STATUS ===\n');

for (const [key, s] of Object.entries(schemes)) {
  const isActive = s.netUnits > 0.0001;
  console.log(`[${isActive ? 'ACTIVE' : 'REDEEMED'}] ${key}`);
  console.log(`  Net Units: ${s.netUnits.toFixed(3)} | Txns: ${s.txns.length} | Realized P&L: +₹${s.realizedPnl.toFixed(2)}`);
}

