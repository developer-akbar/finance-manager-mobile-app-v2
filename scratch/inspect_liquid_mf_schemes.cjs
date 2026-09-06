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
    s.adjUnits += posChange;
    s.adjCount++;
  }
}

console.log('=== LIQUID MUTUAL FUNDS SCHEME DETAILS ===\n');
for (const [sym, s] of Object.entries(liquidSchemes)) {
  console.log(`Scheme: ${sym}`);
  console.log(`  ISIN: ${s.isin}`);
  console.log(`  BUYs:             ${s.buyCount} txns | Units: ${s.buyUnits.toFixed(3)} | Cost: ₹${s.buyCost.toFixed(2)}`);
  console.log(`  UNIT_ADJUSTMENTs: ${s.adjCount} txns | Units: ${s.adjUnits.toFixed(3)}`);
  console.log(`  SELLs:            ${s.sellCount} txns | Units: ${s.sellUnits.toFixed(3)} | Proceeds: ₹${s.sellProceeds.toFixed(2)} | CostBasis: ₹${s.sellCostBasis.toFixed(2)}`);
  console.log(`  Realized P&L:     +₹${s.realizedPnl.toFixed(2)}`);
  console.log(`  Final Net Units:  ${s.netUnits.toFixed(3)} (Formula: BUY ${s.buyUnits.toFixed(3)} + ADJ ${s.adjUnits.toFixed(3)} - SELL ${s.sellUnits.toFixed(3)} = ${(s.buyUnits + s.adjUnits - s.sellUnits).toFixed(3)})`);
  console.log(`  Total Txns:       ${s.txns.length} (BUY ${s.buyCount} + ADJ ${s.adjCount} + SELL ${s.sellCount})\n`);
}

