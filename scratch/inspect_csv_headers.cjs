const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split('\n').filter(l => l.trim());
const headerLine = lines[0];
const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));

console.log('CSV Headers count:', headers.length);
console.log('Headers:', headers);

const rows = lines.slice(1).map(line => {
  const values = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { values.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
    else cur += c;
  }
  values.push(cur.trim().replace(/^"|"$/g, ''));
  const obj = {};
  headers.forEach((h, idx) => { obj[h] = values[idx] || ''; });
  return obj;
});

console.log(`Total rows read: ${rows.length}`);
