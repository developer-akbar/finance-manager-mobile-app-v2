const fs = require('fs');
const crypto = require('crypto');

function parseCSV(text) {
  if (!text || !text.trim()) return { headers: [], rows: [] };
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

function stringifyCSV(headers, rows) {
  const escapeField = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.map(escapeField).join(',')];
  for (const r of rows) {
    const rowFields = headers.map(h => escapeField(r[h] || ''));
    lines.push(rowFields.join(','));
  }
  return lines.join('\n');
}

const v3 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v3.csv', 'utf8'));

console.log(`Loaded ${v3.rows.length} rows from V3 baseline.`);

// Deep Investigation of the 13 Rows:
// Row mappings in V3 (1-indexed based on data rows):
// 2018 Cluster: 25130, 25170, 25171, 25172, 25187, 25311, 25321, 25588
// 2020 FTMF Cluster: 20472, 20473, 20474, 20475, 20476

const v4Rows = v3.rows.map((r, idx) => {
  const rowNum = idx + 1;
  const row = { ...r };

  // 1. Row 25588: 11/02/2018 | Lend -> Cash | ₹2500
  // Economic event: Haseena aunty repaid loan/gift, injected into Cash drawer.
  if (rowNum === 25588) {
    row.Category = 'Lend';
    row.Subcategory = 'Recovery';
    row.Note = 'Haseena aunty loan repayment';
    row.Description = 'Loan recovery from Haseena aunty credited to Cash drawer (historically memo-tagged as adjusted from share market)';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  // 2. Row 25311: 28/02/2018 | Cash Expense | ₹1295 | Cat: Useless
  // Economic event: Manual recording of day-trading cash deficit.
  if (rowNum === 25311) {
    row.Category = 'Equity';
    row.Subcategory = 'Trading Loss';
    row.Note = 'Manual share market loss settlement';
    row.Description = 'Manual recording of day-trading loss (matched against Lend compensation in row 25321)';
    row.AccountingClassification = 'REAL_INVESTMENT_PNL';
  }

  // 3. Row 25321: 28/02/2018 | Lend -> Cash | ₹1295
  // Economic event: Compensating internal cash transfer from Lend clearing to Cash drawer to neutralize Row 25311.
  if (rowNum === 25321) {
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Cash Balancing';
    row.Note = 'Cash drawer replenishment';
    row.Description = 'Internal transfer from Lend clearing to neutralize manual trading loss in row 25311';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  // 4. Row 25187: 25/03/2018 | Lend -> SBI | ₹1500
  // Economic event: Profit on Munvar mobile phone sale credited to SBI.
  if (rowNum === 25187) {
    row.Category = 'Income';
    row.Subcategory = 'Secondary Profit';
    row.Note = 'Profit on Munvar mobile sale';
    row.Description = 'Margin profit on Munvar mobile phone transaction credited to SBI (historically memo-tagged as adjusted from share market)';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  // 5. Row 25170: 29/03/2018 | Lend -> SBI | ₹101
  // Economic event: FY18 year-end settlement from Lend clearing into SBI.
  if (rowNum === 25170) {
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Settlement';
    row.Note = 'FY18 Lend clearing settlement';
    row.Description = 'Year-end clearing settlement from Lend account to SBI';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  // 6. Row 25171: 29/03/2018 | Lend -> Cash | ₹253
  // Economic event: FY18 year-end petty cash alignment from Lend clearing into Cash drawer.
  if (rowNum === 25171) {
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Settlement';
    row.Note = 'FY18 Cash drawer alignment';
    row.Description = 'Year-end clearing alignment from Lend account to Cash drawer';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  // 7. Row 25172: 29/03/2018 | Lend -> HDFC | ₹486
  // Economic event: FY18 year-end settlement from Lend clearing into HDFC.
  if (rowNum === 25172) {
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Settlement';
    row.Note = 'FY18 Lend clearing settlement';
    row.Description = 'Year-end clearing settlement from Lend account to HDFC';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  // 8. Row 25130: 05/04/2018 | Lend -> HDFC | ₹3865
  // Economic event: Capital replenishment from Lend clearing into HDFC following peak Feb trading drawdowns.
  if (rowNum === 25130) {
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Capital Replenishment';
    row.Note = 'HDFC bank capital replenishment';
    row.Description = 'Capital replenishment from Lend clearing to HDFC bank account';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  // 9-13. 2020 FTMF Cluster: Rows 20472 to 20476 (30/06/2020)
  // Economic event: Rebalancing transfers from Liquid MF to bank accounts during Franklin lockdown.
  if (rowNum === 20472) { // ₹759 Liquid MF -> HDFC
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Liquidity Transfer';
    row.Note = 'Franklin liquidity transfer to HDFC';
    row.Description = 'Transfer from Liquid Mutual Funds ledger to HDFC bank';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }
  if (rowNum === 20473) { // ₹671 Liquid MF -> ICICI
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Liquidity Transfer';
    row.Note = 'Franklin liquidity transfer to ICICI';
    row.Description = 'Transfer from Liquid Mutual Funds ledger to ICICI bank';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }
  if (rowNum === 20474) { // ₹269 Liquid MF -> Amazon
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Liquidity Transfer';
    row.Note = 'Franklin liquidity transfer to Amazon Pay';
    row.Description = 'Transfer from Liquid Mutual Funds ledger to Amazon Pay wallet';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }
  if (rowNum === 20475) { // ₹884 Liquid MF -> SBI
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Liquidity Transfer';
    row.Note = 'Franklin liquidity transfer to SBI';
    row.Description = 'Transfer from Liquid Mutual Funds ledger to SBI bank';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }
  if (rowNum === 20476) { // ₹144 Liquid MF -> HDFC
    row.Category = 'Internal Transfer';
    row.Subcategory = 'Liquidity Transfer';
    row.Note = 'Franklin liquidity transfer to HDFC';
    row.Description = 'Transfer from Liquid Mutual Funds ledger to HDFC bank';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  return row;
});

const v4Content = stringifyCSV(v3.headers, v4Rows);
const targetPath = 'scratch/finman_reconstructed_master_preview_v4.csv';
fs.writeFileSync(targetPath, v4Content, 'utf8');

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
const stat = fs.statSync(targetPath);

console.log(`\nSuccessfully created separate dry-run preview V4: ${targetPath}`);
console.log(`- File Size: ${stat.size} bytes`);
console.log(`- Total Rows: ${v4Rows.length + 1} (including header)`);
console.log(`- SHA-256: ${sha256}`);

// Comprehensive V4 vs V3 Reconciliation Audit
function calcFullAudit(rows) {
  const bal = {};
  const subBal = {};
  let totalIncome = 0;
  let totalExpense = 0;

  rows.forEach(t => {
    const type = t['Income/Expense'];
    const amt = parseFloat(t.INR || t.Amount || 0);
    if (isNaN(amt) || amt === 0) return;

    const acct = t.Account || t.FromAccount;
    const toAcct = t.ToAccount;
    const sub = t.SubAccount || t.FromSubAccount;
    const toSub = t.ToSubAccount;

    if (type === 'Income') {
      totalIncome += amt;
      if (acct) bal[acct] = (bal[acct] || 0) + amt;
      if (acct && sub) {
        const k = `${acct} › ${sub}`;
        subBal[k] = (subBal[k] || 0) + amt;
      }
    } else if (type === 'Expense') {
      totalExpense += amt;
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
  return { bal, subBal, totalIncome, totalExpense };
}

const audit3 = calcFullAudit(v3.rows);
const audit4 = calcFullAudit(v4Rows);

console.log('\n--- V4 vs V3 ACCOUNT BALANCES AUDIT (All 35 Accounts) ---');
const allAccounts = Object.keys(audit3.bal).sort();
let allAccountsMatch = true;

allAccounts.forEach(acct => {
  const b3 = audit3.bal[acct] || 0;
  const b4 = audit4.bal[acct] || 0;
  const diff = b4 - b3;
  if (Math.abs(diff) > 0.0001) {
    console.log(`❌ Diff in ${acct}: V3=₹${b3.toFixed(2)}, V4=₹${b4.toFixed(2)}, Diff=₹${diff.toFixed(2)}`);
    allAccountsMatch = false;
  } else {
    console.log(`${acct.padEnd(25)} | V3: ₹${b3.toFixed(2).padStart(12)} | V4: ₹${b4.toFixed(2).padStart(12)} | Diff: ₹0.00`);
  }
});

if (allAccountsMatch) {
  console.log('✅ ALL 35 ACCOUNT BALANCES IN V4 ARE 100% IDENTICAL TO V3 TO THE PAISA!');
}

console.log('\n--- KEY SUBACCOUNTS AUDIT ---');
const subKeys = [
  'Mutual Funds Tax Saver › Ak ETMoney',
  'Liquid Mutual Funds › Ak ETMoney',
  'Liquid Mutual Funds › Fareeda Groww',
  'Liquid Mutual Funds › Ammi Groww',
  'Share Market › Zerodha',
  'Share Market › Fareeda Groww'
];
subKeys.forEach(k => {
  const b3 = audit3.subBal[k] || 0;
  const b4 = audit4.subBal[k] || 0;
  const diff = b4 - b3;
  console.log(`${k.padEnd(40)} | V3: ₹${b3.toFixed(2).padStart(12)} | V4: ₹${b4.toFixed(2).padStart(12)} | Diff: ₹${diff.toFixed(2)}`);
});

