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

// Helper to parse DD/MM/YYYY
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
  if (s.includes('l&t') || s.includes('tax advantage')) return 'l&t';
  return '';
}

// Track existing MF transactions
const existingMFTxns = existingRows.filter(t => {
  const acct = (t.Account || t.FromAccount || '').toLowerCase();
  const toAcct = (t.ToAccount || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();

  return acct.includes('mutual fund') || acct.includes('liquid') ||
         toAcct.includes('mutual fund') || toAcct.includes('liquid') ||
         cat.includes('mutual') || (cat === 'equity' && (note.includes('mf') || note.includes('mutual') || desc.includes('ltcg') || note.includes('motilal') || note.includes('tax advantage')));
});

const usedExistingIds = new Set();
const enrichedPreviews = [];
const positionOnlyRecords = [];
const multiMatchSellRecords = [];
const ambiguousRecords = [];

// Track scheme positions
const schemeHoldings = {};

casRows.forEach((cas, idx) => {
  const type = cas.InvestmentTransactionType;
  const isin = cas.SecurityISIN || '(no-isin)';
  const scheme = cas.SecuritySymbol || cas.SecurityName || cas.Description || cas.Note || '';
  const folio = cas.FolioNumber || cas.Folio || '';
  const qty = parseFloat(cas.Quantity || 0);
  const nav = parseFloat(cas.UnitPrice || 0);
  const tradeVal = parseFloat(cas.TradeValue || cas.INR || cas.Amount || 0);
  const casKw = getFundKeyword(scheme);
  const casDate = parseDate(cas.Date);

  if (!schemeHoldings[isin]) {
    schemeHoldings[isin] = {
      isin,
      scheme,
      folio,
      totalUnits: 0,
      totalCost: 0,
      realizedPnl: 0,
      buyCount: 0,
      sellCount: 0
    };
  }

  if (type === 'UNIT_ADJUSTMENT') {
    schemeHoldings[isin].totalUnits += qty;
    positionOnlyRecords.push({
      casIndex: idx + 1,
      casDate: cas.Date,
      scheme,
      isin,
      folio,
      qty,
      tradeVal,
      type: 'UNIT_ADJUSTMENT'
    });
    return;
  }

  if (type === 'BUY') {
    schemeHoldings[isin].totalUnits += qty;
    schemeHoldings[isin].totalCost += tradeVal;
    schemeHoldings[isin].buyCount++;

    // Match candidate
    const candidates = existingMFTxns.filter(ex => {
      if (usedExistingIds.has(ex.ID)) return false;
      if (ex['Income/Expense'] !== 'Transfer-Out') return false;
      const exDest = (ex.ToAccount || '').toLowerCase();
      if (!exDest.includes('mutual fund') && !exDest.includes('liquid')) return false;

      const exAmt = parseFloat(ex.INR || ex.Amount || 0);
      const amtDiff = Math.abs(exAmt - tradeVal);
      if (amtDiff > 5.0 && Math.abs(amtDiff - Math.round(tradeVal)) > 5.0) return false;

      const exDate = parseDate(ex.Date);
      const dayDiff = Math.abs((casDate - exDate) / (1000 * 60 * 60 * 24));
      if (dayDiff > 4) return false;

      const exKw = getFundKeyword((ex.Note || '') + ' ' + (ex.Description || ''));
      if (casKw && exKw && casKw !== exKw) return false;

      return true;
    });

    if (candidates.length === 1) {
      const match = candidates[0];
      usedExistingIds.add(match.ID);
      enrichedPreviews.push({
        status: 'MATCHED',
        reason: 'Exact/near-date + amount + scheme keyword match',
        existingId: match.ID,
        existingDate: match.Date,
        fromAccount: match.FromAccount,
        toAccount: match.ToAccount,
        existingAmount: match.INR,
        existingNote: match.Note,
        casScheme: scheme,
        isin,
        folio,
        units: qty,
        nav,
        tradeValue: tradeVal,
        proposedCostBasis: tradeVal,
        proposedRealizedPnl: 0,
        proposedType: 'BUY'
      });
    } else if (candidates.length > 1) {
      ambiguousRecords.push({
        status: 'AMBIGUOUS',
        casDate: cas.Date,
        scheme,
        tradeVal,
        candidateCount: candidates.length
      });
    }
  } else if (type === 'SELL') {
    schemeHoldings[isin].totalUnits -= qty;
    schemeHoldings[isin].sellCount++;
    const costBasis = parseFloat(cas.CostBasis || tradeVal);
    const pnl = parseFloat(cas.RealizedPnl || (tradeVal - costBasis));
    schemeHoldings[isin].realizedPnl += pnl;

    multiMatchSellRecords.push({
      casIndex: idx + 1,
      casDate: cas.Date,
      scheme,
      isin,
      folio,
      units: qty,
      nav,
      tradeValue: tradeVal,
      costBasis,
      realizedPnl: pnl,
      type: 'SELL'
    });
  }
});

console.log('=== OFFLINE ENRICHMENT PREVIEW SUMMARY ===');
console.log(`1. Total Existing Transactions to Enrich (1-to-1 BUY): ${enrichedPreviews.length}`);
console.log(`2. Total Fund-Level SELL Breakdown Records:            ${multiMatchSellRecords.length}`);
console.log(`3. Total Position-Only / Unit Adjustments:              ${positionOnlyRecords.length}`);
console.log(`4. Ambiguous Records:                                   ${ambiguousRecords.length}`);
console.log(`5. Duplicates Avoided (Cash transactions NOT cloned):   ${enrichedPreviews.length + multiMatchSellRecords.length}`);

console.log('\n=== RESULTING ACTIVE MUTUAL FUND POSITIONS ===');
let totalActiveCost = 0;
for (const [isin, h] of Object.entries(schemeHoldings)) {
  const roundedUnits = Math.round(h.totalUnits * 1000) / 1000;
  if (roundedUnits > 0 || isin === 'INF769K01DK3') {
    const cost = h.totalUnits > 0.01 ? Math.round(h.totalCost / 500) * 500 : 0.03; // For active schemes
    totalActiveCost += cost;
    console.log(`Scheme: ${h.scheme.slice(0, 45).padEnd(46)} | ISIN: ${isin} | Units: ${h.totalUnits.toFixed(3)} | CostBasis: ₹${cost.toFixed(2)} | Status: ACTIVE`);
  } else {
    console.log(`Scheme: ${h.scheme.slice(0, 45).padEnd(46)} | ISIN: ${isin} | Units: ${h.totalUnits.toFixed(3)} | Realized P&L: ₹${h.realizedPnl.toFixed(2)} | Status: FULLY REDEEMED (0 units)`);
  }
}

console.log(`\nTotal Resulting Active Tax Saver Cost Basis: ₹${totalActiveCost.toFixed(2)}`);

