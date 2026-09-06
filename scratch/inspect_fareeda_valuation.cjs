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

console.log('=== ALL ROWS INVOLVING "Share Market" AND (Fareeda OR Groww) ===');
const smFareeda = rows.filter(r => {
  const acct = r.Account || r.FromAccount || '';
  const dest = r.ToAccount || '';
  const sub = r.SubAccount || r.FromSubAccount || r.ToSubAccount || '';
  const note = r.Note || '';
  const desc = r.Description || '';
  return (acct === 'Share Market' || dest === 'Share Market') && (sub.toLowerCase().includes('fareeda') || sub.toLowerCase().includes('groww') || note.toLowerCase().includes('fareeda') || note.toLowerCase().includes('groww') || desc.toLowerCase().includes('fareeda') || desc.toLowerCase().includes('groww'));
});

console.log(`Count: ${smFareeda.length}`);
let totalFunding = 0;
let totalWithdrawals = 0;
smFareeda.forEach((r, i) => {
  const inr = parseFloat(r.INR || r.Amount || 0);
  const type = r['Income/Expense'];
  const from = r.FromAccount || r.Account;
  const to = r.ToAccount;
  if (type === 'Transfer-Out' && to === 'Share Market') totalFunding += inr;
  if (type === 'Transfer-Out' && from === 'Share Market') totalWithdrawals += inr;
  console.log(`  ${i+1}. Line ${r.ID || i+2} | Date: ${r.Date} | Type: ${r['Income/Expense']} | ${from} -> ${to} | Sub: ${r.SubAccount} | FromSub: ${r.FromSubAccount} | ToSub: ${r.ToSubAccount} | INR: ${r.INR} | Note: ${r.Note} | Desc: ${r.Description}`);
});
console.log(`Total Funding to Fareeda Groww in Share Market: ${totalFunding}`);
console.log(`Total Withdrawals from Fareeda Groww in Share Market: ${totalWithdrawals}`);
console.log(`Net: ${totalFunding - totalWithdrawals}`);

// Let's also search where ₹123,003 or ₹23,012 or ₹99,991 appears in the CSV!
console.log('\n=== SEARCHING SPECIFIC AMOUNTS: 123003, 23012, 99991 ===');
rows.forEach((r, i) => {
  const inr = parseFloat(r.INR || r.Amount || 0);
  const desc = r.Description || '';
  const note = r.Note || '';
  if (inr === 123003 || inr === 23012 || inr === 99991 || desc.includes('123003') || desc.includes('99991') || note.includes('123003')) {
    console.log(`  Row ${i+2}: Date: ${r.Date} | Type: ${r['Income/Expense']} | From: ${r.FromAccount || r.Account} -> ${r.ToAccount} | INR: ${r.INR} | Note: ${r.Note} | Desc: ${r.Description}`);
  }
});

// Let's search all valuations in descriptions or notes
console.log('\n=== VALUATIONS IN NOTES/DESCRIPTIONS ===');
rows.forEach((r, i) => {
  const str = `${r.Note || ''} ${r.Description || ''}`;
  if (str.includes('123') || str.includes('Groww') || str.includes('Fareeda')) {
    const lines = str.split(/\r?\n/);
    lines.forEach(l => {
      if (l.toLowerCase().includes('groww') || l.toLowerCase().includes('fareeda') || l.includes(':')) {
        console.log(`  Line: "${l}"`);
      }
    });
  }
});

