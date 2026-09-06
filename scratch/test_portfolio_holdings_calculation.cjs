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

function resolveSchemeKey(t) {
  if (t.SecuritySymbol) return t.SecuritySymbol;
  if (t.SecurityISIN) return t.SecurityISIN;
  return t.Note || t.Description || 'Unspecified';
}

function resolveHoldingParent(t) {
  const dest = t.ToAccount;
  const acct = t.Account || t.FromAccount;
  if (dest === 'Liquid Mutual Funds' || acct === 'Liquid Mutual Funds') return 'Liquid Mutual Funds';
  if (dest === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver') return 'Mutual Funds Tax Saver';
  if (dest === 'Share Market' || acct === 'Share Market') return 'Share Market';
  return null;
}

// Calculate holdings for CAS transactions
const holdings = {};
for (const t of allTxns) {
  if (t.Source !== 'CAMS_CAS') continue;
  const parent = resolveHoldingParent(t);
  if (!parent) continue;

  const scheme = resolveSchemeKey(t);
  const key = `${parent} > ${scheme}`;

  if (!holdings[key]) {
    holdings[key] = {
      parent,
      scheme,
      txns: [],
      netUnits: 0,
      totalInvested: 0,
      totalProceeds: 0,
      realizedPnl: 0,
      unitAdjs: 0
    };
  }

  holdings[key].txns.push(t);
  const qty = parseFloat(t.Quantity || t.PositionQuantityChange || 0);
  const type = t.InvestmentTransactionType;
  const tradeVal = parseFloat(t.TradeValue || t.CostBasis || t.INR || 0);
  const pnl = parseFloat(t.RealizedPnl || 0);

  if (type === 'BUY') {
    holdings[key].netUnits += qty;
    holdings[key].totalInvested += tradeVal;
  } else if (type === 'SELL') {
    holdings[key].netUnits += qty; // qty is negative on SELL
    holdings[key].totalProceeds += tradeVal;
    holdings[key].realizedPnl += pnl;
  } else if (type === 'UNIT_ADJUSTMENT') {
    holdings[key].netUnits += qty;
    holdings[key].unitAdjs++;
  }
}

console.log('=== HOLDINGS AUDIT: ACTIVE VS REDEEMED BY NET UNITS ===\n');

let activeHoldings = 0;
let redeemedHoldings = 0;

for (const [key, h] of Object.entries(holdings)) {
  const isHoldingActive = h.netUnits > 0.0005; // 0.001 is Mirae regular residual
  if (isHoldingActive) activeHoldings++;
  else redeemedHoldings++;

  console.log(`[${isHoldingActive ? 'ACTIVE HOLDING  ' : 'REDEEMED HOLDING'}] ${key}`);
  console.log(`    Net Units: ${h.netUnits.toFixed(3)} | Txns: ${h.txns.length} | Realized P&L: +₹${h.realizedPnl.toFixed(2)} | Invested: ₹${h.totalInvested.toFixed(2)}`);
}

console.log(`\nTotal Active Schemes:   ${activeHoldings}`);
console.log(`Total Redeemed Schemes: ${redeemedHoldings}`);
