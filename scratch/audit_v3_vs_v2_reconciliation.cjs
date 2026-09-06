const fs = require('fs');

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return { headers: [], rows: [] };
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return { headers, rows };
}

const v2 = parseCSV(fs.readFileSync('scratch/finman_CAS_enriched_master_preview_v2.csv', 'utf8'));
const v3 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v3.csv', 'utf8'));

console.log(`V2 Row Count: ${v2.rows.length}`);
console.log(`V3 Row Count: ${v3.rows.length}`);

// 1. Investigate 1045 vs 724 discrepancy in V3
const v3ClassCounts = {};
v3.rows.forEach(r => {
  const c = r.AccountingClassification || 'UNTAGGED';
  v3ClassCounts[c] = (v3ClassCounts[c] || 0) + 1;
});
console.log('\n--- V3 Classification Counts ---', v3ClassCounts);

// Let's inspect the 1045 records (163 CAS + 882 Zerodha) and see what they were tagged in V3:
let casCount = 0;
let zerodhaCount = 0;
const zerodhaTagBreakdown = {};
const casTagBreakdown = {};

v3.rows.forEach((r, idx) => {
  const isCas = r.Source === 'CAMS_CAS';
  const isZerodha = (r.Account === 'Share Market' || r.FromAccount === 'Share Market' || r.ToAccount === 'Share Market') && (r.Brokerage === 'Zerodha' || r.Source === 'Zerodha' || r.Category === 'Equity' || r.InvestmentTransactionType);

  if (isCas) {
    casCount++;
    casTagBreakdown[r.AccountingClassification] = (casTagBreakdown[r.AccountingClassification] || 0) + 1;
  }
  if (isZerodha) {
    zerodhaCount++;
    zerodhaTagBreakdown[r.AccountingClassification] = (zerodhaTagBreakdown[r.AccountingClassification] || 0) + 1;
  }
});

console.log(`\nCAS Records Total: ${casCount}`, casTagBreakdown);
console.log(`Zerodha Records Total: ${zerodhaCount}`, zerodhaTagBreakdown);

// 2. Row-by-Row Field Comparison between V2 and V3
const fieldsToCompare = [
  'Date', 'Time', 'Account', 'FromAccount', 'ToAccount', 'Category', 'Subcategory',
  'Note', 'Description', 'INR', 'Amount', 'Income/Expense', 'SubAccount', 'FromSubAccount',
  'ToSubAccount', 'InvestmentTransactionType', 'Brokerage', 'SecuritySymbol', 'SecurityISIN',
  'Quantity', 'UnitPrice', 'TradeValue', 'CostBasis', 'CashImpact', 'PositionQuantityChange',
  'RealizedPnl', 'TradeId', 'OrderId', 'Exchange', 'Segment', 'Source'
];

let mismatchCount = 0;
const mismatches = [];

for (let i = 0; i < v2.rows.length; i++) {
  const r2 = v2.rows[i];
  const r3 = v3.rows[i];

  for (const f of fieldsToCompare) {
    const val2 = r2[f] || '';
    const val3 = r3[f] || '';
    if (val2 !== val3) {
      mismatchCount++;
      if (mismatches.length < 10) {
        mismatches.push({ row: i + 1, field: f, v2: val2, v3: val3 });
      }
    }
  }
}

console.log(`\n--- ROW-BY-ROW ORIGINAL FIELD COMPARISON ---`);
console.log(`Total original financial field mismatches across 28,846 rows: ${mismatchCount}`);
if (mismatchCount === 0) {
  console.log(`✅ 100% PERFECT IDENTITY: Not a single original field in any row differs between V2 and V3!`);
} else {
  console.log('Sample mismatches:', mismatches);
}

// 3. Complete 35 Account Balances in V2 vs V3
const distinctAccounts = new Set();
v2.rows.forEach(r => {
  if (r.Account) distinctAccounts.add(r.Account);
  if (r.FromAccount) distinctAccounts.add(r.FromAccount);
  if (r.ToAccount) distinctAccounts.add(r.ToAccount);
});
v3.rows.forEach(r => {
  if (r.Account) distinctAccounts.add(r.Account);
  if (r.FromAccount) distinctAccounts.add(r.FromAccount);
  if (r.ToAccount) distinctAccounts.add(r.ToAccount);
});

function calcBalances(rows) {
  const bal = {};
  const subBal = {};
  rows.forEach(t => {
    const type = t['Income/Expense'];
    const amt = parseFloat(t.INR || t.Amount || 0);
    if (isNaN(amt) || amt === 0) return;

    const acct = t.Account || t.FromAccount;
    const toAcct = t.ToAccount;
    const sub = t.SubAccount || t.FromSubAccount;
    const toSub = t.ToSubAccount;

    if (type === 'Income') {
      if (acct) bal[acct] = (bal[acct] || 0) + amt;
      if (acct && sub) {
        const k = `${acct} › ${sub}`;
        subBal[k] = (subBal[k] || 0) + amt;
      }
    } else if (type === 'Expense') {
      if (acct) bal[acct] = (bal[acct] || 0) - amt;
      if (acct && sub) {
        const k = `${acct} › ${sub}`;
        subBal[k] = (subBal[k] || 0) - amt;
      }
    } else if (type === 'Transfer-Out') {
      if (acct) bal[acct] = (bal[acct] || 0) - amt;
      if (toAcct) bal[toAcct] = (bal[toAcct] || 0) + amt;

      if (acct && sub) {
        const k = `${acct} › ${sub}`;
        subBal[k] = (subBal[k] || 0) - amt;
      }
      if (toAcct && toSub) {
        const k = `${toAcct} › ${toSub}`;
        subBal[k] = (subBal[k] || 0) + amt;
      }
    }
  });
  return { bal, subBal };
}

const b2 = calcBalances(v2.rows);
const b3 = calcBalances(v3.rows);

console.log(`\n--- EXACT 35 ACCOUNTS AUDIT (Total Distinct Accounts: ${distinctAccounts.size}) ---`);
const acctList = Array.from(distinctAccounts).sort();
acctList.forEach(acct => {
  const val2 = b2.bal[acct] || 0;
  const val3 = b3.bal[acct] || 0;
  const diff = val3 - val2;
  console.log(`${acct.padEnd(25)} | V2: ₹${val2.toFixed(2).padStart(12)} | V3: ₹${val3.toFixed(2).padStart(12)} | Diff: ₹${diff.toFixed(2)}`);
});

console.log('\n--- KEY SUBACCOUNTS RECONCILIATION ---');
const subKeys = [
  'Mutual Funds Tax Saver › Ak ETMoney',
  'Liquid Mutual Funds › Ak ETMoney',
  'Liquid Mutual Funds › Fareeda Groww',
  'Liquid Mutual Funds › Ammi Groww',
  'Share Market › Zerodha',
  'Share Market › Fareeda Groww'
];
subKeys.forEach(k => {
  const val2 = b2.subBal[k] || 0;
  const val3 = b3.subBal[k] || 0;
  const diff = val3 - val2;
  console.log(`${k.padEnd(40)} | V2: ₹${val2.toFixed(2).padStart(12)} | V3: ₹${val3.toFixed(2).padStart(12)} | Diff: ₹${diff.toFixed(2)}`);
});

