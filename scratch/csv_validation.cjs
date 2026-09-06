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

console.log('=== CSV VALIDATION REPORT ===');

const idMap = new Map();
let duplicateIdRows = [];
let missingIdRows = [];

rows.forEach((r, idx) => {
  const lineNo = idx + 2;
  const id = r.ID || r.id;
  if (!id) {
    missingIdRows.push(lineNo);
  } else {
    if (idMap.has(id)) {
      duplicateIdRows.push({ id, lines: [idMap.get(id), lineNo] });
    } else {
      idMap.set(id, lineNo);
    }
  }
});

console.log(`Total Rows: ${rows.length}`);
console.log(`Missing IDs: ${missingIdRows.length} rows`);
console.log(`Duplicate IDs: ${duplicateIdRows.length} instances`);
if (duplicateIdRows.length > 0) {
  console.log('Sample Duplicate IDs:', duplicateIdRows.slice(0, 5));
}

// Check trade rows in Zerodha
let buyNoQty = [];
let buyNoCost = [];
let sellNoQty = [];
let sellNoProceeds = [];
let malformedDesc = [];
let reconRows = [];
let pnlRows = [];
let chargeRows = [];
let dividendRows = [];
let bankFundingRows = [];
let bankWithdrawalRows = [];

rows.forEach((r, idx) => {
  const lineNo = idx + 2;
  const desc = String(r.Description || '').trim();
  const note = String(r.Note || '').trim();
  const cat = String(r.Category || '').trim();
  const acct = String(r.Account || r.FromAccount || '').trim();
  const dest = String(r.ToAccount || '').trim();
  const sub = String(r.SubAccount || r.FromSubAccount || '').trim();
  const destSub = String(r.ToSubAccount || '').trim();
  const inr = parseFloat(r.INR || r.Amount || 0);

  const isZerodha = (sub === 'Zerodha' || destSub === 'Zerodha' ||
    (acct === 'Share Market' && !sub) || (dest === 'Share Market' && !destSub) ||
    desc.includes('Broker=Zerodha') || note.toLowerCase().includes('zerodha'));

  if (isZerodha) {
    if (desc.startsWith('BUY |') || desc.startsWith('BUY|')) {
      const q = desc.match(/Qty=([^|]+)/);
      const c = desc.match(/Cost=([^|]+)/) || desc.match(/TradeValue=([^|]+)/);
      if (!q || isNaN(parseFloat(q[1]))) buyNoQty.push({ lineNo, desc });
      if (!c || isNaN(parseFloat(c[1]))) buyNoCost.push({ lineNo, desc });
      if (desc.includes('EntryDate=UNKNOWN') || desc.includes('Source=CurrentP&L') || desc.includes('historical position closure')) {
        reconRows.push({ lineNo, desc });
      }
    } else if (desc.startsWith('BUY_RECON')) {
      reconRows.push({ lineNo, desc });
    } else if (desc.startsWith('SELL |') || desc.startsWith('SELL|')) {
      const q = desc.match(/Qty=([^|]+)/);
      const p = desc.match(/SaleProceeds=([^|]+)/) || desc.match(/TradeValue=([^|]+)/);
      if (!q || isNaN(parseFloat(q[1]))) sellNoQty.push({ lineNo, desc });
      if (!p || isNaN(parseFloat(p[1]))) sellNoProceeds.push({ lineNo, desc });
    } else if (note === 'Zerodha Gains' || note === 'Zerodha Losses') {
      pnlRows.push({ lineNo, note, inr, desc });
    } else if (note === 'Zerodha Charges' || desc.includes('trading charges')) {
      chargeRows.push({ lineNo, note, inr, desc });
    } else if (note.toLowerCase().includes('dividend') || cat.toLowerCase().includes('dividend')) {
      dividendRows.push({ lineNo, note, inr, desc });
    } else if (r['Income/Expense'] === 'Transfer-Out') {
      if (acct !== 'Share Market' && dest === 'Share Market') {
        bankFundingRows.push({ lineNo, from: acct, to: dest, inr });
      } else if (acct === 'Share Market' && dest !== 'Share Market') {
        bankWithdrawalRows.push({ lineNo, from: acct, to: dest, inr });
      }
    }
  }
});

console.log(`BUY rows without quantity: ${buyNoQty.length}`);
console.log(`BUY rows without price/cost: ${buyNoCost.length}`);
console.log(`SELL rows without quantity: ${sellNoQty.length}`);
console.log(`SELL rows without sale proceeds: ${sellNoProceeds.length}`);
console.log(`Historical reconstruction BUY rows: ${reconRows.length}`);
console.log(`P&L rows (Zerodha Gains & Losses): ${pnlRows.length}`);
console.log(`Charges rows: ${chargeRows.length}`);
console.log(`Dividend rows: ${dividendRows.length}`);
console.log(`Bank funding rows: ${bankFundingRows.length}`);
console.log(`Bank withdrawal rows: ${bankWithdrawalRows.length}`);
console.log('Sample Reconstruction Rows:', reconRows);

