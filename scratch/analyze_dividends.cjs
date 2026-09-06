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

const dividendRows = [];
rows.forEach((r, idx) => {
  const note = String(r.Note || '').toLowerCase();
  const cat = String(r.Category || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  if (note.includes('dividend') || cat.includes('dividend') || desc.includes('dividend')) {
    dividendRows.push({ lineNo: idx + 2, row: r });
  }
});

console.log('=== ALL 40 DIVIDEND ROWS IN CSV ===');
dividendRows.forEach(({ lineNo, row }, i) => {
  const amt = parseFloat(row.INR || row.Amount || 0);
  console.log(`${(i+1).toString().padStart(2)}. Line ${lineNo.toString().padStart(5)} | Date: ${row.Date || 'UNKNOWN'} | INR: ₹${amt.toFixed(2).padStart(6)} | Note: ${row.Note.padEnd(10)} | Desc: ${row.Description}`);
});

// Check subsets summing to 7.55
console.log('\nSubsets of dividends totaling ₹7.55:');
for (let i = 0; i < dividendRows.length; i++) {
  const a = parseFloat(dividendRows[i].row.INR || 0);
  if (Math.abs(a - 7.55) < 0.001) {
    console.log(`Single row match: ${i+1} (${a})`);
  }
  for (let j = i + 1; j < dividendRows.length; j++) {
    const b = parseFloat(dividendRows[j].row.INR || 0);
    if (Math.abs(a + b - 7.55) < 0.001) {
      console.log(`Two rows match: ${i+1} (${a}) + ${j+1} (${b})`);
    }
    for (let k = j + 1; k < dividendRows.length; k++) {
      const c = parseFloat(dividendRows[k].row.INR || 0);
      if (Math.abs(a + b + c - 7.55) < 0.001) {
        console.log(`Three rows match: ${i+1} (${a}) + ${j+1} (${b}) + ${k+1} (${c})`);
      }
    }
  }
}

