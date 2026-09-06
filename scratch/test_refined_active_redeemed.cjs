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

// Scheme active units map
const schemeUnits = {};
for (const t of allTxns) {
  if (t.Source !== 'CAMS_CAS') continue;
  const sym = t.SecuritySymbol;
  if (!sym) continue;
  const posChange = parseFloat(t.PositionQuantityChange || 0);
  schemeUnits[sym] = (schemeUnits[sym] || 0) + posChange;
}

console.log('=== SCHEME NET UNITS AUDIT ===');
for (const [sym, units] of Object.entries(schemeUnits)) {
  console.log(`  ${sym.slice(0, 50).padEnd(50)}: ${units.toFixed(3)} units -> ${units > 0.0005 ? 'ACTIVE' : 'REDEEMED'}`);
}

function isTransactionForActiveHolding(t) {
  if (t.Source === 'CAMS_CAS' && t.SecuritySymbol) {
    const units = schemeUnits[t.SecuritySymbol] || 0;
    return units > 0.0005;
  }
  // For non-CAS transactions (e.g. Fareeda Groww, Ammi Groww, Zerodha)
  const invType = String(t.InvestmentTransactionType || '').trim().toUpperCase();
  if (invType === 'SELL') return false;
  const note = String(t.Note || '').toLowerCase();
  const desc = String(t.Description || '').toLowerCase();
  const combined = `${note} ${desc}`;
  if (combined.includes('redeemed') || combined.includes('redemption') || combined.includes('from share market')) return false;
  return true;
}

const casLiquid = allTxns.filter(t => t.Source === 'CAMS_CAS' && (t.Account === 'Liquid Mutual Funds' || t.FromAccount === 'Liquid Mutual Funds' || t.ToAccount === 'Liquid Mutual Funds'));
const casTaxSaver = allTxns.filter(t => t.Source === 'CAMS_CAS' && (t.Account === 'Mutual Funds Tax Saver' || t.FromAccount === 'Mutual Funds Tax Saver' || t.ToAccount === 'Mutual Funds Tax Saver'));

const liquidActive = casLiquid.filter(isTransactionForActiveHolding);
const liquidRedeemed = casLiquid.filter(t => !isTransactionForActiveHolding(t));

const taxSaverActive = casTaxSaver.filter(isTransactionForActiveHolding);
const taxSaverRedeemed = casTaxSaver.filter(t => !isTransactionForActiveHolding(t));

console.log('\n=== LIQUID MF CAS AUDIT ===');
console.log(`- Active Txns (belonging to active holdings):   ${liquidActive.length} (Expected: 0)`);
console.log(`- Redeemed Txns (belonging to redeemed holdings): ${liquidRedeemed.length} (Expected: 45)`);

console.log('\n=== TAX SAVER CAS AUDIT ===');
console.log(`- Active Txns (belonging to 6 active schemes):    ${taxSaverActive.length}`);
console.log(`- Redeemed Txns (belonging to 4 redeemed schemes): ${taxSaverRedeemed.length}`);
console.log(`- Total Tax Saver CAS: ${taxSaverActive.length + taxSaverRedeemed.length} (Expected: 118)`);

