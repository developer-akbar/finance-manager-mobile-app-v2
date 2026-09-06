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

// Find existing MF cash transactions
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

console.log('Existing MF transactions in FinMan:', existingMFTxns.length);

// Extract fund keywords for matching
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

// Matching engine
const matchedCAS = [];
const ambiguousCAS = [];
const unmatchedCAS = [];
const positionOnlyCAS = [];

const usedExistingIds = new Set();

casRows.forEach((cas, idx) => {
  const type = cas.InvestmentTransactionType;
  const casDate = parseDate(cas.Date);
  const casAmt = parseFloat(cas.TradeValue || cas.INR || cas.Amount || 0);
  const casScheme = cas.SecuritySymbol || cas.SecurityName || cas.Description || cas.Note || '';
  const casKw = getFundKeyword(casScheme);

  if (type === 'UNIT_ADJUSTMENT') {
    positionOnlyCAS.push({
      casIndex: idx,
      cas,
      reason: 'Stamp duty / fraction unit adjustment'
    });
    return;
  }

  if (type === 'BUY') {
    // Look for Bank -> MF transfers with matching amount & date
    const candidates = existingMFTxns.filter(ex => {
      if (usedExistingIds.has(ex.ID)) return false;
      const exType = ex['Income/Expense'];
      if (exType !== 'Transfer-Out') return false;
      const exDest = (ex.ToAccount || '').toLowerCase();
      if (!exDest.includes('mutual fund') && !exDest.includes('liquid')) return false;

      const exAmt = parseFloat(ex.INR || ex.Amount || 0);
      const amtDiff = Math.abs(exAmt - casAmt);
      if (amtDiff > 5.0 && Math.abs(amtDiff - Math.round(casAmt)) > 5.0) return false;

      const exDate = parseDate(ex.Date);
      const dayDiff = Math.abs((casDate - exDate) / (1000 * 60 * 60 * 24));
      if (dayDiff > 4) return false;

      // Check keyword match if available
      const exKw = getFundKeyword((ex.Note || '') + ' ' + (ex.Description || ''));
      if (casKw && exKw && casKw !== exKw) return false;

      return true;
    });

    if (candidates.length === 1) {
      const match = candidates[0];
      usedExistingIds.add(match.ID);
      matchedCAS.push({
        casIndex: idx,
        cas,
        existingTxn: match,
        matchType: 'EXACT_BUY',
        dayDiff: Math.abs((casDate - parseDate(match.Date)) / (1000 * 60 * 60 * 24)),
        amtDiff: Math.abs(parseFloat(match.INR || 0) - casAmt)
      });
    } else if (candidates.length > 1) {
      ambiguousCAS.push({
        casIndex: idx,
        cas,
        candidates,
        reason: `Multiple (${candidates.length}) candidate transfers found`
      });
    } else {
      unmatchedCAS.push({
        casIndex: idx,
        cas,
        reason: 'No matching Bank -> MF transfer within ±4 days and ±₹5'
      });
    }
  } else if (type === 'SELL') {
    // Look for MF -> Bank transfers or redemption entries
    const candidates = existingMFTxns.filter(ex => {
      const exType = ex['Income/Expense'];
      const exFrom = (ex.FromAccount || ex.Account || '').toLowerCase();
      const isRedeem = exType === 'Transfer-Out' && (exFrom.includes('mutual fund') || exFrom.includes('liquid'));
      if (!isRedeem) return false;

      const exDate = parseDate(ex.Date);
      const dayDiff = Math.abs((casDate - exDate) / (1000 * 60 * 60 * 24));
      if (dayDiff > 10) return false;

      const exKw = getFundKeyword((ex.Note || '') + ' ' + (ex.Description || ''));
      if (casKw && exKw && casKw !== exKw) return false;

      return true;
    });

    if (candidates.length >= 1) {
      matchedCAS.push({
        casIndex: idx,
        cas,
        existingTxn: candidates[0],
        matchType: 'EXACT_SELL',
        candidates
      });
    } else {
      unmatchedCAS.push({
        casIndex: idx,
        cas,
        reason: 'No matching MF redemption transfer found'
      });
    }
  }
});

console.log('\n==================================================');
console.log('=== CAS MATCHING RESULTS SUMMARY ===');
console.log('==================================================');
console.log(`Total CAS Rows:        ${casRows.length}`);
console.log(`Matched Rows:          ${matchedCAS.length}`);
console.log(`Position Only Rows:    ${positionOnlyCAS.length}`);
console.log(`Ambiguous Rows:        ${ambiguousCAS.length}`);
console.log(`Unmatched Rows:        ${unmatchedCAS.length}`);

console.log('\n--- SAMPLE 10 MATCHED ROWS ---');
matchedCAS.slice(0, 10).forEach((m, i) => {
  const c = m.cas;
  const e = m.existingTxn;
  console.log(`[${i+1}] CAS Date: ${c.Date} | Scheme: ${c.SecuritySymbol?.slice(0, 25)} | Units: ${c.Quantity} | NAV: ${c.UnitPrice} | Val: ₹${c.TradeValue}`);
  console.log(`     -> FinMan ID: ${e.ID} | Date: ${e.Date} | From: ${e.FromAccount} | To: ${e.ToAccount} | INR: ₹${e.INR} | Note: ${e.Note}`);
});

if (unmatchedCAS.length > 0) {
  console.log('\n--- UNMATCHED ROWS ---');
  unmatchedCAS.forEach((u, i) => {
    const c = u.cas;
    console.log(`[${i+1}] Date: ${c.Date} | Type: ${c.InvestmentTransactionType} | Scheme: ${c.SecuritySymbol} | Val: ₹${c.TradeValue || c.INR} | Reason: ${u.reason}`);
  });
}

if (ambiguousCAS.length > 0) {
  console.log('\n--- AMBIGUOUS ROWS ---');
  ambiguousCAS.forEach((a, i) => {
    const c = a.cas;
    console.log(`[${i+1}] Date: ${c.Date} | Type: ${c.InvestmentTransactionType} | Scheme: ${c.SecuritySymbol} | Val: ₹${c.TradeValue} | Candidates: ${a.candidates.length}`);
  });
}

