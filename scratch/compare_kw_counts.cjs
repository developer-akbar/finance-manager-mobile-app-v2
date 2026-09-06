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

// Group CAS BUYs by scheme keyword
const casBuyByKw = {};
casRows.filter(r => r.InvestmentTransactionType === 'BUY').forEach(r => {
  const kw = getFundKeyword(r.SecuritySymbol || r.Description);
  if (!casBuyByKw[kw]) casBuyByKw[kw] = [];
  casBuyByKw[kw].push(r);
});

// Group FinMan transfers by scheme keyword
const finmanXfersByKw = {};
baseFinManRows.filter(r => {
  const toAcct = (r.ToAccount || '').toLowerCase();
  return r['Income/Expense'] === 'Transfer-Out' && (toAcct.includes('mutual fund') || toAcct.includes('liquid'));
}).forEach(r => {
  const kw = getFundKeyword((r.Note || '') + ' ' + (r.Description || ''));
  if (!finmanXfersByKw[kw]) finmanXfersByKw[kw] = [];
  finmanXfersByKw[kw].push(r);
});

console.log('=== CAS BUY COUNTS VS FINMAN TRANSFER COUNTS BY SCHEME KEYWORD ===');
const allKws = new Set([...Object.keys(casBuyByKw), ...Object.keys(finmanXfersByKw)]);
allKws.forEach(kw => {
  const casCount = casBuyByKw[kw] ? casBuyByKw[kw].length : 0;
  const finCount = finmanXfersByKw[kw] ? finmanXfersByKw[kw].length : 0;
  console.log(`Keyword: "${kw.padEnd(10)}" | CAS BUYs: ${String(casCount).padStart(3)} | FinMan Transfers: ${String(finCount).padStart(3)}`);
});

