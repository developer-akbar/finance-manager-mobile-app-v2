const fs = require('fs');

function parseCSV(text) {
  if (!text || !text.trim()) return { headers: [], rows: [] };
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

  if (records.length < 2) return { headers: [], rows: [] };
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
  return { headers, rows };
}

const v4_2 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4_2.csv', 'utf8'));

const motilalSell = v4_2.rows.find(r => r.Date === '08/12/2025' && r.SecuritySymbol.includes('Motilal') && r.InvestmentTransactionType === 'SELL');
console.log('--- MOTILAL OSWAL SELL RECORD ---');
console.log(JSON.stringify(motilalSell, null, 2));

const dspBuy = v4_2.rows.find(r => r.InvestmentTransactionType === 'BUY' && r.Source === 'CAMS_CAS');
console.log('\n--- CAS BUY RECORD ---');
console.log(JSON.stringify(dspBuy, null, 2));

