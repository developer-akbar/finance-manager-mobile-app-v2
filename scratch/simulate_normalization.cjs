const fs = require('fs');
const path = require('path');

// Read CSV
const csvPath = path.resolve('finman_2026-09-02.csv');
const rawContent = fs.readFileSync(csvPath, 'utf8');

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const headerLine = lines[0];
  // Simple CSV split for standard header
  const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    
    // Parse commas respecting quotes
    const vals = [];
    let cur = '';
    let inQuote = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        vals.push(cur.replace(/^"|"$/g, '').trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    vals.push(cur.replace(/^"|"$/g, '').trim());
    
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = vals[idx] !== undefined ? vals[idx] : '';
    });
    obj._line = i;
    rows.push(obj);
  }
  return { headers, rows };
}

// Logic from brokerageAccounting.js
function resolveInvestmentSubAccount(t, parentAsset) {
  if (!t) return null;
  const parent = parentAsset || String(t.InvestmentAccount || t.investment_account || t.Account || t.ToAccount || t.FromAccount || '').trim();

  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
  const sub = String(
    t.SubAccount || t.sub_account ||
    (invType === 'BUY' ? (t.ToSubAccount || t.to_sub_account) : (t.FromSubAccount || t.from_sub_account)) ||
    t.Brokerage || t.brokerage ||
    t.ToSubAccount || t.to_sub_account ||
    t.FromSubAccount || t.from_sub_account || ''
  ).trim();
  if (sub && sub !== 'Default') return sub;

  const src = String(t.Source || t.source || '').trim();
  if (src.includes('CAS') || src.includes('CAMS')) {
    return 'Ak ETMoney';
  }

  const note = String(t.Note || t.note || '').toLowerCase();
  const desc = String(t.Description || t.description || '').toLowerCase();
  const combined = `${note} ${desc}`;

  const parentLower = String(parent || '').toLowerCase();

  if (parentLower.includes('share market') || parentLower === 'share market') {
    if (combined.includes('groww') || combined.includes('fareeda')) return 'Fareeda Groww';
    return 'Zerodha';
  }

  if (parentLower.includes('tax saver') || parentLower === 'mutual funds tax saver') {
    return 'Ak ETMoney';
  }

  if (parentLower.includes('liquid') || parentLower === 'liquid mutual funds') {
    if (combined.includes('ammi grow') || combined.includes('ammi')) return 'Ammi Groww';
    if (combined.includes('fareeda') && combined.includes('groww')) return 'Fareeda Groww';
    if (combined.includes('fareeda') && combined.includes('etmoney')) return 'Fareeda ETMoney';
    if (combined.includes('scripbox')) return 'Scripbox';
    if (combined.includes('groww')) return 'Fareeda Groww';
    if (t.InvestmentTransactionType || t.SecurityISIN) return 'Ak ETMoney';
    return null;
  }

  return null;
}

// Logic from Accounts.jsx computeBalance
function computeSubAccountBalance(txns, acctName, subAccountName) {
  let bal = 0;
  for (const t of txns) {
    const amt = parseFloat(t.Amount || t.INR || 0) || 0;
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();
    const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
    const tradeVal = parseFloat(t.TradeValue || t.trade_value || amt);

    const sub = String(t.SubAccount || t.sub_account || '').trim();
    const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
    const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

    const isFromInv = fromAcct === 'Mutual Funds Tax Saver' || fromAcct === 'Liquid Mutual Funds' || fromAcct === 'Share Market';
    const isDestInv = dest === 'Mutual Funds Tax Saver' || dest === 'Liquid Mutual Funds' || dest === 'Share Market';
    const isAcctInv = acct === 'Mutual Funds Tax Saver' || acct === 'Liquid Mutual Funds' || acct === 'Share Market';

    const resolvedFromSub = (fromSub && fromSub !== 'Default') ? fromSub : (isFromInv ? resolveInvestmentSubAccount(t, fromAcct) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedToSub = (toSub && toSub !== 'Default') ? toSub : (isDestInv ? resolveInvestmentSubAccount(t, dest) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedAcctSub = (sub && sub !== 'Default') ? sub : (isAcctInv ? resolveInvestmentSubAccount(t, acct) : '');

    if (invType === 'BUY') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal += (tradeVal || amt);
      }
    } else if (invType === 'SELL') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal -= (tradeVal || amt);
      }
    } else if (type === 'Income') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal += amt;
      }
    } else if (type === 'Expense') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal -= amt;
      }
    } else if (type === 'Transfer-Out') {
      if (fromAcct === acctName && resolvedFromSub === subAccountName) {
        bal -= amt;
      }
      if (dest === acctName && resolvedToSub === subAccountName) {
        bal += amt;
      }
    }
  }
  return bal;
}

function computeParentBalance(txns, acctName) {
  let bal = 0;
  for (const t of txns) {
    const amt = parseFloat(t.Amount || t.INR || 0) || 0;
    const type = String(t['Income/Expense'] || '').trim();
    const acct = t.Account || t.FromAccount || '';
    const dest = t.ToAccount || '';

    if (type === 'Income') { if (acct === acctName) bal += amt; }
    else if (type === 'Expense') { if (acct === acctName) bal -= amt; }
    else if (type === 'Transfer-Out') {
      if (acct === acctName) bal -= amt;
      if (dest === acctName) bal += amt;
    }
  }
  return bal;
}

const { headers, rows } = parseCSV(rawContent);

console.log('=== BEFORE NORMALIZATION ===');
console.log('Total Transactions:', rows.length);
console.log('Parent Liquid MF Balance:', computeParentBalance(rows, 'Liquid Mutual Funds'));
console.log('  Fareeda Groww:', computeSubAccountBalance(rows, 'Liquid Mutual Funds', 'Fareeda Groww'));
console.log('  Fareeda ETMoney:', computeSubAccountBalance(rows, 'Liquid Mutual Funds', 'Fareeda ETMoney'));
console.log('  Ammi Groww:', computeSubAccountBalance(rows, 'Liquid Mutual Funds', 'Ammi Groww'));
console.log('  Ak ETMoney:', computeSubAccountBalance(rows, 'Liquid Mutual Funds', 'Ak ETMoney'));

// Modifications map
const TARGET_MODS = {
  // Ammi cashback (3 transactions)
  "c24bc7db-14f6-4e3d-8752-f5a243d48d45": "Ammi Groww", // 6125
  "c4843272-3289-4a41-ac3b-59e552377384": "Ammi Groww", // 4901
  "a710ce84-4979-4d31-8537-6060225dd292": "Ammi Groww", // 4232
  // Fareeda ETMoney (8 transactions)
  "6075a44d-a7af-4885-9ae7-8457c3420666": "Fareeda ETMoney", // 6404
  "70bc6df2-f39b-44e1-9795-1f4ca58f0b7b": "Fareeda ETMoney", // 6405
  "78fc33c4-33ee-49e5-ad8b-6d074f8fdf3a": "Fareeda ETMoney", // 6577
  "be603713-6b6d-48fe-be34-e9254f7b6d86": "Fareeda ETMoney", // 6578
  "7cf8ce64-9fc8-4790-b207-6cc616b79d57": "Fareeda ETMoney", // 6579
  "efdcd0b6-ffb7-4fe4-aa9b-05d26c010f61": "Fareeda ETMoney", // 6580
  "540accf4-76b8-4f76-abfd-02305949ddbd": "Fareeda ETMoney", // 6581
  "84310067-22a3-4714-9381-5bab6f16cde2": "Fareeda ETMoney", // 6582
};

// Deep copy rows and apply modifications
const normalizedRows = rows.map(r => {
  const copy = { ...r };
  if (TARGET_MODS[copy.ID]) {
    copy.SubAccount = TARGET_MODS[copy.ID];
  }
  return copy;
});

console.log('\n=== AFTER NORMALIZATION ===');
console.log('Total Transactions:', normalizedRows.length);
console.log('Parent Liquid MF Balance:', computeParentBalance(normalizedRows, 'Liquid Mutual Funds'));
console.log('  Fareeda Groww:', computeSubAccountBalance(normalizedRows, 'Liquid Mutual Funds', 'Fareeda Groww'));
console.log('  Fareeda ETMoney:', computeSubAccountBalance(normalizedRows, 'Liquid Mutual Funds', 'Fareeda ETMoney'));
console.log('  Ammi Groww:', computeSubAccountBalance(normalizedRows, 'Liquid Mutual Funds', 'Ammi Groww'));
console.log('  Ak ETMoney:', computeSubAccountBalance(normalizedRows, 'Liquid Mutual Funds', 'Ak ETMoney'));

