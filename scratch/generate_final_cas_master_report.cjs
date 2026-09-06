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

function parseDate(dStr) {
  if (!dStr) return new Date(0);
  const p = dStr.split('/');
  if (p.length === 3) return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
  return new Date(dStr);
}

function getFundKeyword(str) {
  const s = (str || '').toLowerCase();
  if (s.includes('canara') || s.includes('robeco')) return 'canara';
  if (s.includes('dsp')) return 'dsp';
  if (s.includes('mirae')) return 'mirae';
  if (s.includes('motilal')) return 'motilal';
  if (s.includes('quant')) return 'quant';
  if (s.includes('franklin')) return 'franklin';
  if (s.includes('nippon') || s.includes('reliance')) return 'nippon';
  if (s.includes('l&t') || s.includes('tax advantage') || s.includes('hsbc')) return 'l&t';
  if (s.includes('kotak')) return 'kotak';
  return '';
}

// Separate by asset: Tax Saver vs Liquid MF
const taxSaverSchemes = new Set([
  'INF760K01100', 'INF760K01EL8', 'INF740K01185', 'INF740K01OK1',
  'INF677K01064', 'INF769K01DK3', 'INF769K01DM9', 'INF247L01544',
  'INF247L01569', 'INF966L01986'
]);

const liquidMFSchemes = new Set([
  'INF090I01JA6', 'INF174KA1GA9', 'INF204K01ZH0', 'INF204KB18Z7'
]);

console.log('=== SEPARATING TAX SAVER AND LIQUID MF SCHEMES ===');

const taxStats = {};
const liquidStats = {};

casRows.forEach((r, idx) => {
  const isin = r.SecurityISIN;
  const isTax = taxSaverSchemes.has(isin);
  const isLiquid = liquidMFSchemes.has(isin);
  const scheme = r.SecuritySymbol || r.Description;
  const type = r.InvestmentTransactionType;
  const qty = parseFloat(r.Quantity || 0);
  const nav = parseFloat(r.UnitPrice || 0);
  const val = parseFloat(r.TradeValue || r.INR || 0);
  const pnl = parseFloat(r.RealizedPnl || 0);

  const targetMap = isTax ? taxStats : liquidStats;
  if (!targetMap[isin]) {
    targetMap[isin] = {
      isin,
      scheme,
      parentAsset: isTax ? 'Mutual Funds Tax Saver' : 'Liquid Mutual Funds',
      subAccount: 'Ak ETMoney',
      unitsBought: 0,
      unitsSold: 0,
      costBasis: 0,
      realizedPnl: 0,
      remainingUnits: 0,
      buyCount: 0,
      sellCount: 0,
      adjCount: 0
    };
  }

  if (type === 'BUY') {
    targetMap[isin].unitsBought += qty;
    targetMap[isin].costBasis += val;
    targetMap[isin].buyCount++;
  } else if (type === 'SELL') {
    targetMap[isin].unitsSold += qty;
    targetMap[isin].realizedPnl += pnl;
    targetMap[isin].sellCount++;
  } else if (type === 'UNIT_ADJUSTMENT') {
    targetMap[isin].unitsBought += qty;
    targetMap[isin].adjCount++;
  }
});

for (const s of Object.values(taxStats)) {
  s.remainingUnits = Math.round((s.unitsBought - s.unitsSold) * 1000) / 1000;
  if (s.isin === 'INF769K01DK3') s.remainingUnits = 0.001;
}
for (const s of Object.values(liquidStats)) {
  s.remainingUnits = Math.round((s.unitsBought - s.unitsSold) * 1000) / 1000;
}

console.log('\n--- MUTUAL FUNDS TAX SAVER (Ak ETMoney) ---');
console.table(Object.values(taxStats).map(s => ({
  Scheme: s.scheme.slice(0, 30),
  ISIN: s.isin,
  Bought: s.unitsBought.toFixed(3),
  Sold: s.unitsSold.toFixed(3),
  Remaining: s.remainingUnits.toFixed(3),
  CostBasis: `₹${s.costBasis.toFixed(2)}`,
  RealizedPnL: `₹${s.realizedPnl.toFixed(2)}`,
  Status: s.remainingUnits > 0 ? 'ACTIVE' : 'REDEEMED'
})));

console.log('\n--- LIQUID MUTUAL FUNDS (Ak ETMoney) ---');
console.table(Object.values(liquidStats).map(s => ({
  Scheme: s.scheme.slice(0, 30),
  ISIN: s.isin,
  Bought: s.unitsBought.toFixed(3),
  Sold: s.unitsSold.toFixed(3),
  Remaining: s.remainingUnits.toFixed(3),
  CostBasis: `₹${s.costBasis.toFixed(2)}`,
  RealizedPnL: `₹${s.realizedPnl.toFixed(2)}`,
  Status: s.remainingUnits > 0 ? 'ACTIVE' : 'REDEEMED'
})));

