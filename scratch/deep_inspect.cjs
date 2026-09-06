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

// Let's inspect rows with notes "Zerodha Losses", "Zerodha Gains", "Other Credit & Debit", etc.
console.log('=== Deep Inspection of Row Categories ===');

let totalGainsRows = 0;
let totalLossesRows = 0;
let totalOtherCreditDebitRows = 0;
let totalChargesRows = 0;

rows.forEach((r, idx) => {
  const note = String(r.Note || '').trim();
  const desc = String(r.Description || '').trim();
  const amt = parseFloat(r.INR || r.Amount || 0);

  if (note === 'Zerodha Gains') {
    totalGainsRows += amt;
  } else if (note === 'Zerodha Losses') {
    totalLossesRows += amt;
  } else if (note === 'Other Credit & Debit') {
    totalOtherCreditDebitRows += amt;
  } else if (note.includes('Charges') || desc.includes('charges') || desc.includes('CHARGE')) {
    if (String(r.Account || r.FromAccount || r.ToAccount || desc || note).toLowerCase().includes('zerodha')) {
      console.log('Charge row:', idx + 2, r.Date, r['Income/Expense'], r.Account, r.FromAccount, r.ToAccount, r.INR, r.Note, r.Description);
      totalChargesRows += amt;
    }
  }
});

console.log('Zerodha Gains rows sum:', totalGainsRows);
console.log('Zerodha Losses rows sum:', totalLossesRows);
console.log('Other Credit & Debit rows sum:', totalOtherCreditDebitRows);
console.log('Charges sum:', totalChargesRows);

// Let's check special rows: 'Zerodha total trading charges...', 'Realized P&L reconciliation', 'Vishal Mart IPO...', 'BUY_RECON'
console.log('\n=== Special Rows ===');
rows.forEach((r, idx) => {
  const desc = String(r.Description || '');
  const note = String(r.Note || '');
  if (
    desc.includes('reconciliation') ||
    desc.includes('trading charges') ||
    desc.includes('Vishal Mart') ||
    desc.startsWith('BUY_RECON') ||
    desc.startsWith('POSITION_STATUS') ||
    desc.startsWith('BONUS') ||
    note.includes('reconciliation')
  ) {
    console.log(`Row ${idx + 2}:`);
    console.log(`  Date: ${r.Date}, Type: ${r['Income/Expense']}, Acct: ${r.Account}, From: ${r.FromAccount}, To: ${r.ToAccount}, Sub: ${r.SubAccount}, FromSub: ${r.FromSubAccount}, ToSub: ${r.ToSubAccount}`);
    console.log(`  INR: ${r.INR}, Amount: ${r.Amount}, Cat: ${r.Category}, Note: ${r.Note}`);
    console.log(`  Desc: ${r.Description}`);
  }
});

