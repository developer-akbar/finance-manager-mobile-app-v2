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

// Let's audit the 11 rows that had multiple candidates initially
console.log('=== AUDITING THE 11 AMBIGUOUS CANDIDATES IN DETAIL ===\n');

const usedIds = new Set();
const detailed11 = [];

casRows.forEach((cas, idx) => {
  const type = cas.InvestmentTransactionType;
  if (type !== 'BUY') return;
  const casDate = parseDate(cas.Date);
  const casAmt = parseFloat(cas.TradeValue || cas.INR || cas.Amount || 0);
  const casScheme = cas.SecuritySymbol || cas.SecurityName || cas.Description || cas.Note || '';
  const casKw = getFundKeyword(casScheme);

  // Find all candidate existing transactions
  const dateCandidates = existingMFTxns.filter(ex => {
    const exType = ex['Income/Expense'];
    if (exType !== 'Transfer-Out') return false;
    const exDest = (ex.ToAccount || '').toLowerCase();
    if (!exDest.includes('mutual fund') && !exDest.includes('liquid')) return false;

    const exAmt = parseFloat(ex.INR || ex.Amount || 0);
    const amtDiff = Math.abs(exAmt - casAmt);
    if (amtDiff > 5.0 && Math.abs(amtDiff - Math.round(casAmt)) > 5.0) return false;

    const exDate = parseDate(ex.Date);
    const dayDiff = Math.abs((casDate - exDate) / (1000 * 60 * 60 * 24));
    return dayDiff <= 4;
  });

  if (dateCandidates.length > 1) {
    detailed11.push({
      casIndex: idx,
      cas,
      casKw,
      candidates: dateCandidates
    });
  }
});

console.log(`Found ${detailed11.length} instances where multiple same-date/same-amount transactions exist:\n`);

detailed11.forEach((item, i) => {
  const c = item.cas;
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`[CASE ${i+1}] CAS Row #${item.casIndex + 1}:`);
  console.log(`  Date: ${c.Date} | Type: ${c.InvestmentTransactionType} | Scheme: ${c.SecuritySymbol} | ISIN: ${c.SecurityISIN}`);
  console.log(`  Units: ${c.Quantity} | NAV: ${c.UnitPrice} | TradeValue: ₹${c.TradeValue}`);
  console.log(`  Identified Fund Keyword: "${item.casKw}"`);
  console.log(`  Candidate Existing FinMan Transactions (${item.candidates.length}):`);
  item.candidates.forEach((cand, ci) => {
    const candKw = getFundKeyword((cand.Note || '') + ' ' + (cand.Description || ''));
    const isKeywordMatch = (item.casKw === candKw);
    console.log(`    Candidate #${ci+1}: ID: ${cand.ID} | Date: ${cand.Date} | From: ${cand.FromAccount} | To: ${cand.ToAccount} | INR: ₹${cand.INR} | Note: "${cand.Note}" | Desc: "${cand.Description}" | Keyword: "${candKw}" | KeywordMatch: ${isKeywordMatch}`);
  });
});

