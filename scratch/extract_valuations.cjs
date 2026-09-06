const fs = require('fs');
const { calculateBrokerageState } = require('../src/utils/brokerageAccounting.js');

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

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const txns = parseCSV(raw);

// Find all valuation notes in the CSV
const valuations = {};
txns.forEach(t => {
  const desc = String(t.Description || t.description || '');
  const note = String(t.Note || t.note || '');
  const combined = `${note}\n${desc}`;

  if (combined.includes(':')) {
    const lines = combined.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([^:]+?)\s*:\s*([\d.]+)(?:\s+out\s+of\s+([\d.]+))?\s*$/i);
      if (match) {
        const fundName = match[1].trim();
        if (['time', 'vi', 'jio', 'flipkart', 'amazon'].includes(fundName.toLowerCase())) continue;
        const val = parseFloat(match[2]);
        const inv = match[3] ? parseFloat(match[3]) : null;
        if (!isNaN(val)) {
          valuations[fundName] = { date: t.Date, currentValue: val, investedValue: inv, rawLine: line };
        }
      }
    }
  }
});

console.log('=== VALUATION NOTES FOUND IN CSV ===');
console.log(JSON.stringify(valuations, null, 2));

