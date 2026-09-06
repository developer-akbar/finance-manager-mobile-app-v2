const fs = require('fs');
const path = require('path');

// Simple CSV parser that handles quoted commas
function parseCSV(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  
  // parse header
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

const csvPath = path.resolve('c:/Akbar/Projects/Coding/finman-v2/finman_2026-08-30_shares_data.csv');
console.log('Reading CSV:', csvPath);
const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(raw);
console.log('Total CSV rows:', rows.length);

// Let's inspect columns
console.log('Headers:', Object.keys(rows[0] || {}));

// Let's filter Zerodha related rows
const zerodhaRows = rows.filter(r => {
  const str = JSON.stringify(r).toLowerCase();
  return str.includes('zerodha') || (r.Account === 'Share Market') || (r.FromAccount === 'Share Market') || (r.ToAccount === 'Share Market');
});

console.log('Zerodha/Share Market related rows:', zerodhaRows.length);

// Save summary of row types
const typeCounts = {};
const descTypes = {};
zerodhaRows.forEach(r => {
  const t = r['Income/Expense'];
  typeCounts[t] = (typeCounts[t] || 0) + 1;
  const desc = r.Description || '';
  if (desc.includes('|')) {
    const first = desc.split('|')[0].trim();
    descTypes[first] = (descTypes[first] || 0) + 1;
  } else {
    descTypes['NO_PIPE'] = (descTypes['NO_PIPE'] || 0) + 1;
  }
});

console.log('Income/Expense types:', typeCounts);
console.log('Description first tokens:', descTypes);
