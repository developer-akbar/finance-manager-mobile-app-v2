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

const baseFinManRows = allRows.slice(0, 28786);
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

const buyCasRows = casRows.filter(r => r.InvestmentTransactionType === 'BUY');
console.log('Total BUY rows in CAS:', buyCasRows.length);

const usedExistingIds = new Set();
const matchedBUYs = [];
const unmatchedBUYs = [];

buyCasRows.forEach((cas, idx) => {
  const scheme = cas.SecuritySymbol || cas.Description;
  const casKw = getFundKeyword(scheme);
  const casDate = parseDate(cas.Date);
  const tradeVal = parseFloat(cas.TradeValue || cas.INR || cas.Amount || 0);

  // Multi-pass matching:
  // Pass 1: exact keyword match, ±5 days, ±₹5
  // Pass 2: exact keyword match, ±15 days, ±₹5
  // Pass 3: amount match within same month
  let matched = false;

  const passes = [5, 15, 30];
  for (const maxDays of passes) {
    if (matched) break;
    for (let i = 0; i < baseFinManRows.length; i++) {
      const ex = baseFinManRows[i];
      if (usedExistingIds.has(ex.ID)) continue;
      if (ex['Income/Expense'] !== 'Transfer-Out') continue;
      const exDest = (ex.ToAccount || '').toLowerCase();
      if (!exDest.includes('mutual fund') && !exDest.includes('liquid')) continue;

      const exAmt = parseFloat(ex.INR || ex.Amount || 0);
      const amtDiff = Math.abs(exAmt - tradeVal);
      if (amtDiff > 5.0 && Math.abs(amtDiff - Math.round(tradeVal)) > 5.0) continue;

      const exDate = parseDate(ex.Date);
      const dayDiff = Math.abs((casDate - exDate) / (1000 * 60 * 60 * 24));
      if (dayDiff > maxDays) continue;

      const exKw = getFundKeyword((ex.Note || '') + ' ' + (ex.Description || ''));
      if (casKw && exKw && casKw !== exKw) continue;

      usedExistingIds.add(ex.ID);
      matchedBUYs.push({
        casIdx: idx + 1,
        cas,
        existingTxn: ex,
        dayDiff,
        maxDaysPass: maxDays
      });
      matched = true;
      break;
    }
  }

  if (!matched) {
    unmatchedBUYs.push({
      casIdx: idx + 1,
      cas
    });
  }
});

console.log(`Matched BUYs count: ${matchedBUYs.length} / ${buyCasRows.length}`);
console.log(`Unmatched BUYs count: ${unmatchedBUYs.length}`);

if (unmatchedBUYs.length > 0) {
  unmatchedBUYs.forEach(u => console.log('Unmatched:', u.cas.Date, u.cas.SecuritySymbol, u.cas.TradeValue));
}

