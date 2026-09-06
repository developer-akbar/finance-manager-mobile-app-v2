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

const v4 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4.csv', 'utf8'));

console.log('--- LOCATE EXACT FATHER MF ROWS ---');
v4.rows.forEach((r, idx) => {
  const c = `${r.Note} ${r.Description}`.toLowerCase();
  if (c.includes('father mutual fund') || c.includes('father mf') || (c.includes('father') && c.includes('motilal oswal nifty next 50'))) {
    console.log(`[Row ${idx + 1} / Line ${idx + 2} / ID: ${r.ID}] ${r.Date} | ₹${r.INR || r.Amount} | From: ${r.Account || r.FromAccount} -> To: ${r.ToAccount} | Note: "${r.Note}" | Desc: "${r.Description}"`);
  }
});

