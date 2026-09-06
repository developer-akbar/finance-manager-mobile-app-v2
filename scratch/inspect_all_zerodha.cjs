const fs = require('fs');
const path = require('path');

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

const zerodhaRows = rows.filter(r => {
  const desc = String(r.Description || '');
  const note = String(r.Note || '');
  const cat = String(r.Category || '');
  const acct = String(r.Account || r.FromAccount || '');
  const dest = String(r.ToAccount || '');
  const sub = String(r.SubAccount || r.FromSubAccount || '');
  const destSub = String(r.ToSubAccount || '');
  const broker = r.Brokerage || (desc.match(/Broker=([^|]+)/) ? desc.match(/Broker=([^|]+)/)[1].trim() : '') || (sub === 'Zerodha' || destSub === 'Zerodha' ? 'Zerodha' : '');
  
  return broker === 'Zerodha' ||
    (acct === 'Share Market' && (sub === 'Zerodha' || !sub)) ||
    (dest === 'Share Market' && (destSub === 'Zerodha' || !destSub)) ||
    note.toLowerCase().includes('zerodha') ||
    desc.toLowerCase().includes('zerodha');
});

console.log('Total Zerodha rows:', zerodhaRows.length);

// Let's inspect rows without pipe in Description
const noPipe = zerodhaRows.filter(r => !String(r.Description || '').includes('|'));
console.log('No pipe rows count:', noPipe.length);

const noPipeCategories = {};
noPipe.forEach(r => {
  const k = `${r['Income/Expense']} | ${r.FromAccount || r.Account} -> ${r.ToAccount} | Cat: ${r.Category} | Note: ${r.Note}`;
  noPipeCategories[k] = (noPipeCategories[k] || 0) + 1;
});

console.log('No pipe row patterns (sample):');
Object.entries(noPipeCategories).slice(0, 30).forEach(([k, v]) => console.log(`  [${v}x] ${k}`));

// Let's inspect pipe rows
const pipeRows = zerodhaRows.filter(r => String(r.Description || '').includes('|'));
console.log('Pipe rows count:', pipeRows.length);
const pipeTypes = {};
pipeRows.forEach(r => {
  const first = r.Description.split('|')[0].trim();
  pipeTypes[first] = (pipeTypes[first] || 0) + 1;
});
console.log('Pipe first tokens:', pipeTypes);

