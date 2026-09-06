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

console.log('=== FULL READ-ONLY MF INVESTMENT LIFECYCLE AUDIT ===\n');

// 1. Liquid MF - Scheme-Level Reconciliation
const liquidCas = allTxns.filter(t => t.Source === 'CAMS_CAS' && (t.Account === 'Liquid Mutual Funds' || t.FromAccount === 'Liquid Mutual Funds' || t.ToAccount === 'Liquid Mutual Funds'));

const liquidSchemes = {};
for (const t of liquidCas) {
  const sym = t.SecuritySymbol;
  if (!liquidSchemes[sym]) {
    liquidSchemes[sym] = {
      name: sym,
      isin: t.SecurityISIN,
      buyUnits: 0,
      buyCost: 0,
      buyCount: 0,
      sellUnits: 0,
      sellProceeds: 0,
      sellCostBasis: 0,
      sellCount: 0,
      adjUnits: 0,
      adjCount: 0,
      realizedPnl: 0,
      netUnits: 0,
      txns: []
    };
  }
  const s = liquidSchemes[sym];
  s.txns.push(t);
  const type = t.InvestmentTransactionType;
  const qty = parseFloat(t.Quantity || 0);
  const posChange = parseFloat(t.PositionQuantityChange || 0);
  const tradeVal = parseFloat(t.TradeValue || t.CostBasis || t.INR || t.Amount || 0);
  const costBasis = parseFloat(t.CostBasis || 0);
  const pnl = parseFloat(t.RealizedPnl || 0);

  s.netUnits += posChange;

  if (type === 'BUY') {
    s.buyUnits += qty;
    s.buyCost += tradeVal;
    s.buyCount++;
  } else if (type === 'SELL') {
    s.sellUnits += qty;
    s.sellProceeds += tradeVal;
    s.sellCostBasis += costBasis;
    s.sellCount++;
    s.realizedPnl += pnl;
  } else if (type === 'UNIT_ADJUSTMENT') {
    s.adjUnits += posChange; // can be positive or negative
    s.adjCount++;
  }
}

console.log('--- 1. LIQUID MUTUAL FUNDS SCHEME-LEVEL RECONCILIATION ---');
for (const [sym, s] of Object.entries(liquidSchemes)) {
  console.log(`Scheme: ${sym}`);
  console.log(`  ISIN: ${s.isin}`);
  console.log(`  BUYs:             ${s.buyCount} txns | Units: ${s.buyUnits.toFixed(3)} | Cost: ₹${s.buyCost.toFixed(2)}`);
  console.log(`  UNIT_ADJUSTMENTs: ${s.adjCount} txns | Units: ${s.adjUnits.toFixed(3)}`);
  console.log(`  SELLs:            ${s.sellCount} txns | Units: ${s.sellUnits.toFixed(3)} | Proceeds: ₹${s.sellProceeds.toFixed(2)} | CostBasis: ₹${s.sellCostBasis.toFixed(2)}`);
  console.log(`  Realized P&L:     +₹${s.realizedPnl.toFixed(2)}`);
  console.log(`  Final Net Units:  ${s.netUnits.toFixed(3)} (BUY ${s.buyUnits.toFixed(3)} + ADJ ${s.adjUnits.toFixed(3)} - SELL ${s.sellUnits.toFixed(3)} = ${(s.buyUnits + s.adjUnits - s.sellUnits).toFixed(3)})`);
  console.log(`  Total Txns:       ${s.txns.length} (BUY ${s.buyCount} + ADJ ${s.adjCount} + SELL ${s.sellCount})\n`);
}

// 2. UNIT_ADJUSTMENT Audit
const adjRecords = allTxns.filter(t => t.InvestmentTransactionType === 'UNIT_ADJUSTMENT');
console.log('--- 2. ALL 14 UNIT_ADJUSTMENT RECORDS ---');
adjRecords.forEach((r, idx) => {
  console.log(`[${idx + 1}] Date: ${r.Date} | Scheme: ${r.SecuritySymbol}`);
  console.log(`    Qty Change: ${r.PositionQuantityChange} | UnitPrice/NAV: ₹${r.UnitPrice} | CashImpact: ₹${r.CashImpact} | Source: ${r.Source}`);
  console.log(`    Note: "${r.Note}" | Desc: "${r.Description}"\n`);
});

// 3. Tax Saver Schemes Reconciliation
const taxSaverCas = allTxns.filter(t => t.Source === 'CAMS_CAS' && (t.Account === 'Mutual Funds Tax Saver' || t.FromAccount === 'Mutual Funds Tax Saver' || t.ToAccount === 'Mutual Funds Tax Saver'));

const tsSchemes = {};
for (const t of taxSaverCas) {
  const sym = t.SecuritySymbol;
  if (!tsSchemes[sym]) {
    tsSchemes[sym] = {
      name: sym,
      isin: t.SecurityISIN,
      buyUnits: 0,
      buyCost: 0,
      buyCount: 0,
      sellUnits: 0,
      sellProceeds: 0,
      sellCostBasis: 0,
      sellCount: 0,
      realizedPnl: 0,
      netUnits: 0,
      activeCostBasis: 0,
      txns: []
    };
  }
  const s = tsSchemes[sym];
  s.txns.push(t);
  const type = t.InvestmentTransactionType;
  const qty = parseFloat(t.Quantity || 0);
  const posChange = parseFloat(t.PositionQuantityChange || 0);
  const tradeVal = parseFloat(t.TradeValue || t.CostBasis || t.INR || t.Amount || 0);
  const costBasis = parseFloat(t.CostBasis || 0);
  const pnl = parseFloat(t.RealizedPnl || 0);

  s.netUnits += posChange;

  if (type === 'BUY') {
    s.buyUnits += qty;
    s.buyCost += tradeVal;
    s.buyCount++;
  } else if (type === 'SELL') {
    s.sellUnits += qty;
    s.sellProceeds += tradeVal;
    s.sellCostBasis += costBasis;
    s.sellCount++;
    s.realizedPnl += pnl;
  }
}

console.log('--- 3. TAX SAVER SCHEMES RECONCILIATION ---');
let totalTsActiveCost = 0;
let totalTsRealizedPnl = 0;
let activeTsSchemesCount = 0;
let redeemedTsSchemesCount = 0;

for (const [sym, s] of Object.entries(tsSchemes)) {
  const isActive = s.netUnits > 0.0005;
  if (isActive) {
    activeTsSchemesCount++;
    // For active schemes, calculate active cost basis
    s.activeCostBasis = s.buyCost - s.sellCostBasis;
    totalTsActiveCost += s.activeCostBasis;
  } else {
    redeemedTsSchemesCount++;
  }
  totalTsRealizedPnl += s.realizedPnl;

  console.log(`[${isActive ? 'ACTIVE' : 'REDEEMED'}] ${sym}`);
  console.log(`  BUYs: ${s.buyCount} (Units: ${s.buyUnits.toFixed(3)}, Cost: ₹${s.buyCost.toFixed(2)}) | SELLs: ${s.sellCount} (Units: ${s.sellUnits.toFixed(3)}, Proceeds: ₹${s.sellProceeds.toFixed(2)}, CostBasis: ₹${s.sellCostBasis.toFixed(2)})`);
  console.log(`  Net Units: ${s.netUnits.toFixed(3)} | Active Cost Basis: ₹${s.activeCostBasis.toFixed(2)} | Realized P&L: +₹${s.realizedPnl.toFixed(2)} | Total Txns: ${s.txns.length}\n`);
}

console.log(`Tax Saver Active Cost Basis Sum:   ₹${totalTsActiveCost.toFixed(2)}`);
console.log(`Tax Saver Total Realized P&L Sum:  ₹${totalTsRealizedPnl.toFixed(2)}`);
console.log(`Active Schemes Count:              ${activeTsSchemesCount}`);
console.log(`Redeemed Schemes Count:            ${redeemedTsSchemesCount}`);

