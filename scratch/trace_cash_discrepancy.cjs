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

// Check VMM IPO
console.log('=== VMM IPO CHECK ===');
const vmmRows = rows.filter(r => JSON.stringify(r).includes('VMM'));
vmmRows.forEach((r, i) => console.log(`VMM row ${i+1}: Date: ${r.Date}, Type: ${r['Income/Expense']}, From: ${r.FromAccount || r.Account}, To: ${r.ToAccount}, INR: ${r.INR}, Desc: ${r.Description}`));

// Check Dividend rows breakdown
console.log('\n=== DIVIDEND ROWS DETAILED BREAKDOWN ===');
const dividendRows = rows.filter(r => {
  const cat = String(r.Category || '').toLowerCase();
  const note = String(r.Note || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  return note.includes('dividend') || cat.includes('dividend') || desc.includes('dividend');
});

// Group dividends by stock
const divsByStock = {};
dividendRows.forEach((r) => {
  const desc = r.Description || '';
  const match = desc.match(/from\s+([A-Z0-9#]+)/i);
  let stock = match ? match[1].replace('#', '').toUpperCase() : 'UNKNOWN';
  if (!match) {
    if (desc.includes('JINDWORLD') || desc.includes('0.20')) stock = 'JINDWORLD?';
  }
  const amt = parseFloat(r.INR || r.Amount || 0);
  if (!divsByStock[stock]) divsByStock[stock] = { count: 0, total: 0, items: [] };
  divsByStock[stock].count++;
  divsByStock[stock].total += amt;
  divsByStock[stock].items.push({ date: r.Date, amt, desc });
});

console.log('Dividends grouped by stock:', JSON.stringify(divsByStock, null, 2));

// Check BUY vs SELL cash difference by symbol
console.log('\n=== CASH IMPACT BY SYMBOL IN ZERODHA ===');
const symStats = {};
rows.forEach(r => {
  const desc = String(r.Description || '').trim();
  const inr = parseFloat(r.INR || r.Amount || 0);
  const sub = String(r.SubAccount || r.FromSubAccount || '').trim();
  const isZerodha = (sub === 'Zerodha' || desc.includes('Broker=Zerodha'));

  if (!isZerodha) return;

  if (desc.startsWith('BUY |') || desc.startsWith('BUY|')) {
    const isRecon = desc.includes('EntryDate=UNKNOWN') || desc.includes('Source=CurrentP&L') || desc.includes('historical position closure');
    const symMatch = desc.match(/Symbol=([^|]+)/);
    const sym = symMatch ? symMatch[1].trim().toUpperCase() : 'UNKNOWN';
    if (!symStats[sym]) symStats[sym] = { buyCash: 0, sellCash: 0, reconCost: 0, buyQty: 0, sellQty: 0 };
    const qMatch = desc.match(/Qty=([^|]+)/);
    const q = qMatch ? parseFloat(qMatch[1]) : 0;
    if (isRecon) {
      symStats[sym].reconCost += inr;
    } else {
      symStats[sym].buyCash += inr;
      symStats[sym].buyQty += q;
    }
  } else if (desc.startsWith('SELL |') || desc.startsWith('SELL|')) {
    const symMatch = desc.match(/Symbol=([^|]+)/);
    const sym = symMatch ? symMatch[1].trim().toUpperCase() : 'UNKNOWN';
    if (!symStats[sym]) symStats[sym] = { buyCash: 0, sellCash: 0, reconCost: 0, buyQty: 0, sellQty: 0 };
    const qMatch = desc.match(/Qty=([^|]+)/);
    const q = qMatch ? parseFloat(qMatch[1]) : 0;
    symStats[sym].sellCash += inr;
    symStats[sym].sellQty += q;
  }
});

console.log('Symbol cash statistics summary:');
Object.entries(symStats).forEach(([sym, st]) => {
  const netCash = st.sellCash - st.buyCash;
  const netQty = st.buyQty - st.sellQty;
  console.log(`  ${sym.padEnd(12)}: BuyCash=₹${st.buyCash.toFixed(2).padStart(11)} | SellCash=₹${st.sellCash.toFixed(2).padStart(11)} | NetCash=₹${netCash.toFixed(2).padStart(10)} | NetQty=${netQty} | ReconCost=₹${st.reconCost}`);
});

