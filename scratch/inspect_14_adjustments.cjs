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
  if (s.includes('l&t') || s.includes('tax advantage') || s.includes('hsbc')) return 'l&t';
  if (s.includes('kotak')) return 'kotak';
  return '';
}

// 1. Inspect the 14 UNIT_ADJUSTMENT rows in detail
const adjustments = [];
casRows.forEach((r, idx) => {
  if (r.InvestmentTransactionType === 'UNIT_ADJUSTMENT') {
    adjustments.push({
      casIndex: idx + 1,
      date: r.Date,
      scheme: r.SecuritySymbol || r.Description,
      isin: r.SecurityISIN,
      folio: r.FolioNumber || r.Folio,
      qty: parseFloat(r.Quantity || 0),
      nav: parseFloat(r.UnitPrice || 0),
      tradeVal: parseFloat(r.TradeValue || r.INR || 0)
    });
  }
});

console.log(`Found ${adjustments.length} UNIT_ADJUSTMENT rows in CAS.`);
adjustments.forEach((a, i) => {
  console.log(`[ADJ ${i+1}] CAS Row #${a.casIndex}: Date=${a.date} | Scheme=${a.scheme} | Units=${a.qty} | NAV=${a.nav} | Val=${a.tradeVal}`);
});

