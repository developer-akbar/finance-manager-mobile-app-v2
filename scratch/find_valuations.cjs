const fs = require('fs');

function parseCSV(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] !== undefined ? values[idx] : '';
    });
    rows.push(obj);
  }
  return rows;
}

function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

const raw = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const rows = parseCSV(raw);

console.log('=== ALL VALUATIONS FOUND IN CSV ===');
const valuations = {};
for (const t of rows) {
  const desc = String(t.Description || t.description || '');
  const note = String(t.Note || t.note || '');
  const combined = `${note}\n${desc}`;

  if (combined.includes(':')) {
    const lines = combined.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([^:]+?)\s*:\s*([\d.]+)(?:\s+out\s+of\s+([\d.]+))?\s*$/i);
      if (match) {
        const fundName = match[1].trim();
        const val = parseFloat(match[2]);
        const inv = match[3] ? parseFloat(match[3]) : null;
        if (!isNaN(val)) {
          valuations[fundName] = {
            date: t.Date,
            currentValue: val,
            investedValue: inv,
            rawLine: line
          };
        }
      }
    }
  }
}

console.log(JSON.stringify(valuations, null, 2));

