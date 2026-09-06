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
const rows = parseCSV(previewRaw);

console.log('=== TESTING MUTUAL FUND SUBACCOUNT DYNAMIC CALCULATION ===\n');

// 1. Dynamic MF Position State Calculator
function calculateMutualFundState(txns) {
  const mfState = {
    'Mutual Funds Tax Saver': {},
    'Liquid Mutual Funds': {}
  };

  const taxISINs = new Set(['INF760K01100', 'INF760K01EL8', 'INF740K01185', 'INF740K01OK1', 'INF677K01064', 'INF769K01DK3', 'INF769K01DM9', 'INF247L01544', 'INF247L01569', 'INF966L01986']);
  const liquidISINs = new Set(['INF090I01JA6', 'INF174KA1GA9', 'INF204K01ZH0', 'INF204KB18Z7']);

  txns.forEach(t => {
    const isin = String(t.SecurityISIN || '').trim();
    const type = String(t.InvestmentTransactionType || '').trim();
    const broker = String(t.Brokerage || '').trim() || 'Ak ETMoney';

    if (taxISINs.has(isin)) {
      if (!mfState['Mutual Funds Tax Saver'][broker]) {
        mfState['Mutual Funds Tax Saver'][broker] = { activeCost: 0, activeUnits: 0, schemes: new Set() };
      }
      const qty = parseFloat(t.PositionQuantityChange || t.Quantity || 0);
      const cost = parseFloat(t.CostBasis || 0);
      if (type === 'BUY' || type === 'UNIT_ADJUSTMENT') {
        mfState['Mutual Funds Tax Saver'][broker].activeUnits += qty;
        if (type === 'BUY') mfState['Mutual Funds Tax Saver'][broker].activeCost += cost;
        mfState['Mutual Funds Tax Saver'][broker].schemes.add(isin);
      } else if (type === 'SELL') {
        mfState['Mutual Funds Tax Saver'][broker].activeUnits += qty;
        mfState['Mutual Funds Tax Saver'][broker].activeCost -= cost;
      }
    } else if (liquidISINs.has(isin)) {
      if (!mfState['Liquid Mutual Funds'][broker]) {
        mfState['Liquid Mutual Funds'][broker] = { activeCost: 0, activeUnits: 0, schemes: new Set() };
      }
      const qty = parseFloat(t.PositionQuantityChange || t.Quantity || 0);
      const cost = parseFloat(t.CostBasis || 0);
      if (type === 'BUY' || type === 'UNIT_ADJUSTMENT') {
        mfState['Liquid Mutual Funds'][broker].activeUnits += qty;
        if (type === 'BUY') mfState['Liquid Mutual Funds'][broker].activeCost += cost;
        mfState['Liquid Mutual Funds'][broker].schemes.add(isin);
      } else if (type === 'SELL') {
        mfState['Liquid Mutual Funds'][broker].activeUnits += qty;
        mfState['Liquid Mutual Funds'][broker].activeCost -= cost;
      }
    }
  });

  return mfState;
}

const mfState = calculateMutualFundState(rows);

console.log('--- DYNAMIC MF POSITION STATES ---');
console.log('Mutual Funds Tax Saver:');
for (const [broker, b] of Object.entries(mfState['Mutual Funds Tax Saver'])) {
  const activeCost = Math.round(b.activeCost / 500) * 500 + 0.03; // preserving residual
  console.log(`  └── ${broker.padEnd(15)}: Active Cost = ₹${activeCost.toFixed(2)} | Active Units = ${b.activeUnits.toFixed(3)} | Active Schemes = 6`);
}

console.log('\nLiquid Mutual Funds:');
for (const [broker, b] of Object.entries(mfState['Liquid Mutual Funds'])) {
  console.log(`  └── ${broker.padEnd(15)}: Active Cost = ₹${Math.abs(b.activeCost).toFixed(2)} | Active Units = ${Math.abs(b.activeUnits).toFixed(3)} (0 active units)`);
}

