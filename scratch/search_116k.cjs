const fs = require('fs');

function parseCSV(text) {
  const lines = text.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = [];
    let inQ = false, cur = '';
    for (let j = 0; j < lines[i].length; j++) {
      const c = lines[i][j];
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { row.push(cur); cur = ''; }
      else cur += c;
    }
    row.push(cur);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx] ? row[idx].trim().replace(/^\"|\"$/g, '') : '');
    obj._line = i + 1;
    rows.push(obj);
  }
  return rows;
}

const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

for (const t of txns) {
  const s = JSON.stringify(t);
  if (s.includes('116000') || (t.Note && t.Note.includes('116000'))) {
    console.log(`Line ${t._line}:`, t);
  }
}
