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

// 1. Audit Dividends
const dividendRows = rows.filter(r => {
  const cat = String(r.Category || '').toLowerCase();
  const note = String(r.Note || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  return note.includes('dividend') || cat.includes('dividend') || desc.includes('dividend');
});

console.log('=== DIVIDEND TRANSACTIONS AUDIT ===');
console.log(`Total dividend rows: ${dividendRows.length}`);
let totalDivSum = 0;
dividendRows.forEach((r, idx) => {
  const amt = parseFloat(r.INR || r.Amount || 0);
  totalDivSum += amt;
  const desc = r.Description || '';
  const note = r.Note || '';
  // find symbol
  let symbol = 'UNKNOWN';
  const symMatch = desc.match(/Symbol=([^|]+)/) || desc.match(/\b([A-Z0-9]{3,12})\b/);
  if (symMatch) symbol = symMatch[1];
  else if (note) symbol = note;

  console.log(`${idx + 1}. Date: ${r.Date} | Symbol/Note: ${r.Note} | Desc: ${r.Description} | Amount: ₹${amt.toFixed(2)} | Account: ${r.Account || r.FromAccount} -> ${r.ToAccount}`);
});
console.log(`Total Dividend Sum: ₹${totalDivSum.toFixed(4)}`);

// 2. Audit Zerodha Cash Ledger Movements
console.log('\n=== ZERODHA GENUINE CASH MOVEMENTS AUDIT ===');

let bankFunding = 0;
let bankWithdrawals = 0;
let genuineBuyCash = 0;
let genuineSellCash = 0;
let charges = 0;
let otherCreditDebit = 0;

const fundingList = [];
const withdrawalList = [];
const genuineBuyList = [];
const genuineSellList = [];
const chargeList = [];
const otherCreditDebitList = [];
const excludedReconList = [];
const excludedPnlList = [];

rows.forEach((r, idx) => {
  const lineNo = idx + 2;
  const desc = String(r.Description || '').trim();
  const note = String(r.Note || '').trim();
  const cat = String(r.Category || '').trim();
  const type = String(r['Income/Expense'] || '').trim();
  const acct = String(r.Account || r.FromAccount || '').trim();
  const dest = String(r.ToAccount || '').trim();
  const sub = String(r.SubAccount || r.FromSubAccount || '').trim();
  const destSub = String(r.ToSubAccount || '').trim();
  const inr = parseFloat(r.INR || r.Amount || 0);

  const isZerodha = (sub === 'Zerodha' || destSub === 'Zerodha' ||
    (acct === 'Share Market' && (!sub || sub === 'Zerodha')) ||
    (dest === 'Share Market' && (!destSub || destSub === 'Zerodha')) ||
    desc.includes('Broker=Zerodha') || desc.includes('#Zerodha'));

  if (!isZerodha) return;

  // Check type of row
  if (desc.startsWith('BUY |') || desc.startsWith('BUY|')) {
    const isRecon = desc.includes('EntryDate=UNKNOWN') || desc.includes('Source=CurrentP&L') || desc.includes('historical position closure');
    if (isRecon) {
      excludedReconList.push({ lineNo, desc, inr });
    } else {
      genuineBuyCash += inr;
      genuineBuyList.push({ lineNo, desc, inr, date: r.Date });
    }
  } else if (desc.startsWith('BUY_RECON')) {
    excludedReconList.push({ lineNo, desc, inr });
  } else if (desc.startsWith('SELL |') || desc.startsWith('SELL|')) {
    genuineSellCash += inr;
    genuineSellList.push({ lineNo, desc, inr, date: r.Date });
  } else if (desc.startsWith('POSITION_STATUS') || desc.startsWith('BONUS')) {
    // metadata only
  } else if (note === 'Zerodha Gains' || note === 'Zerodha Losses' || desc.includes('Realized P&L reconciliation')) {
    excludedPnlList.push({ lineNo, note, desc, inr });
  } else if (note === 'Zerodha Charges' || desc.includes('trading charges')) {
    charges += inr; // inr is negative (-3265.1868)
    chargeList.push({ lineNo, inr, desc });
  } else if (note === 'Other Credit & Debit') {
    otherCreditDebit += inr; // negative
    otherCreditDebitList.push({ lineNo, inr, desc });
  } else if (type === 'Transfer-Out') {
    if (acct !== 'Share Market' && dest === 'Share Market') {
      bankFunding += inr;
      fundingList.push({ lineNo, from: acct, to: dest, inr, note, desc, date: r.Date });
    } else if (acct === 'Share Market' && dest !== 'Share Market') {
      bankWithdrawals += inr;
      withdrawalList.push({ lineNo, from: acct, to: dest, inr, note, desc, date: r.Date });
    }
  }
});

console.log('--- Bank Funding Summary ---');
console.log(`Count: ${fundingList.length}, Total: ₹${bankFunding.toFixed(2)}`);
console.log('--- Bank Withdrawal Summary ---');
console.log(`Count: ${withdrawalList.length}, Total: ₹${bankWithdrawals.toFixed(2)}`);
console.log('--- Genuine BUY Cash Summary ---');
console.log(`Count: ${genuineBuyList.length}, Total: ₹${genuineBuyCash.toFixed(2)}`);
console.log('--- Genuine SELL Cash Summary ---');
console.log(`Count: ${genuineSellList.length}, Total: ₹${genuineSellCash.toFixed(2)}`);
console.log('--- Charges Summary ---');
console.log(`Count: ${chargeList.length}, Total: ₹${charges.toFixed(4)}`);
console.log('--- Other Credit & Debit Summary ---');
console.log(`Count: ${otherCreditDebitList.length}, Total: ₹${otherCreditDebit.toFixed(4)}`);
console.log('--- Excluded Historical Reconstruction Rows ---');
console.log(`Count: ${excludedReconList.length}, Total Amount Excluded: ₹${excludedReconList.reduce((s, x) => s + x.inr, 0).toFixed(2)}`);
console.log('--- Excluded Realized P&L Rows ---');
console.log(`Count: ${excludedPnlList.length}, Total P&L Excluded: ₹${excludedPnlList.reduce((s, x) => s + x.inr, 0).toFixed(2)}`);

// Pure Cash Ledger Equation
const rawCashLedger = bankFunding - bankWithdrawals - genuineBuyCash + genuineSellCash + charges + otherCreditDebit;
console.log('\n=== PURE CASH LEDGER RESULT ===');
console.log(`Bank Funding:           +₹${bankFunding.toFixed(2)}`);
console.log(`Bank Withdrawals:       -₹${bankWithdrawals.toFixed(2)}`);
console.log(`Genuine BUY Cash:       -₹${genuineBuyCash.toFixed(2)}`);
console.log(`Genuine SELL Cash:      +₹${genuineSellCash.toFixed(2)}`);
console.log(`Charges:                 ₹${charges.toFixed(4)}`);
console.log(`Other Credit/Debit:      ₹${otherCreditDebit.toFixed(4)}`);
console.log(`----------------------------------------`);
console.log(`Calculated Cash Ledger:  ₹${rawCashLedger.toFixed(2)}`);
console.log(`Expected Zerodha Cash:   ₹15.31`);
console.log(`Discrepancy:             ₹${(15.31 - rawCashLedger).toFixed(2)}`);

