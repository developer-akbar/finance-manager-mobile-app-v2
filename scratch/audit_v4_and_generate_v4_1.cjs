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

const v4Raw = fs.readFileSync('scratch/finman_reconstructed_master_preview_v4.csv', 'utf8');
const v4 = parseCSV(v4Raw);

console.log('=== 1. PHYSICAL V4 CSV VERIFICATION ===');
console.log(`- Data Rows: ${v4.rows.length}`);
console.log(`- Header Line: 1`);
console.log(`- Total Lines in File: ${v4.rows.length + 1} (explains why 28,847 lines = 28,846 data records + 1 header)`);
console.log(`- Column Count: ${v4.headers.length}`);
console.log(`- Column Names: ${v4.headers.join(', ')}`);

// Check Duplicate IDs, missing IDs, malformed
const idSet = new Set();
let dupIdCount = 0;
let missingIdCount = 0;
v4.rows.forEach(r => {
  if (!r.ID) missingIdCount++;
  else if (idSet.has(r.ID)) dupIdCount++;
  else idSet.add(r.ID);
});
console.log(`- Missing IDs: ${missingIdCount}`);
console.log(`- Duplicate IDs: ${dupIdCount}`);

// Classification Distribution
const dist = {};
v4.rows.forEach(r => {
  const c = r.AccountingClassification || 'UNTAGGED';
  dist[c] = (dist[c] || 0) + 1;
});
console.log('- AccountingClassification Distribution:', dist);

const v4Sha = crypto.createHash('sha256').update(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4.csv')).digest('hex');
console.log(`- V4 SHA-256 Checksum: ${v4Sha}`);

// 2. Father MF Ownership Correction & Generation of V4.1
// In V4, the two non-zero Father MF rows were:
// Row 28842: 09/06/2026 | Cash -> Liquid MF | ₹100 | Note: "Father Mutual Fund"
// Row 28844: 12/08/2026 | Canara -> Liquid MF | ₹600 | Note: "Father Mutual Fund"
//
// In V4.1:
// Under Option A:
// - The personal cash flow represents personal expense/payment to Father:
//   Row 28842: Expense from Cash (₹100) | Category: To Home | Subcategory: Father | Note: "Father Mutual Fund payment" | Desc: "Personal payment on behalf of Father (Motilal Oswal Nifty Next 50)"
//   Row 28844: Expense from Canara (₹600) | Category: To Home | Subcategory: Father | Note: "Father Mutual Fund payment" | Desc: "Personal payment on behalf of Father (Motilal Oswal Nifty Next 50)"
// - Plus, to preserve the exact Father MF tracking trail without injecting ₹700 into Liquid Mutual Funds:
//   The investment tracking for Father remains pure tracking (Liquid MF balance is NOT polluted with Father's ₹700).

const v4_1Rows = v4.rows.map((r, idx) => {
  const rowNum = idx + 1;
  const row = { ...r };

  if (rowNum === 28842) {
    row['Income/Expense'] = 'Expense';
    row.Account = 'Cash';
    row.FromAccount = 'Cash';
    row.ToAccount = '';
    row.Category = 'To Home';
    row.Subcategory = 'Father';
    row.Note = 'Father Mutual Fund payment';
    row.Description = 'Personal payment on behalf of Father for Motilal Oswal Nifty Next 50 SIP';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  } else if (rowNum === 28844) {
    row['Income/Expense'] = 'Expense';
    row.Account = 'Canara';
    row.FromAccount = 'Canara';
    row.ToAccount = '';
    row.Category = 'To Home';
    row.Subcategory = 'Father';
    row.Note = 'Father Mutual Fund payment';
    row.Description = 'Personal payment on behalf of Father for Motilal Oswal Nifty Next 50 SIP';
    row.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  return row;
});

const v4_1Content = stringifyCSV(v4.headers, v4_1Rows);
const targetPath = 'scratch/finman_reconstructed_master_preview_v4_1.csv';
fs.writeFileSync(targetPath, v4_1Content, 'utf8');

const v4_1Sha = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
const stat4_1 = fs.statSync(targetPath);

console.log(`\nSuccessfully created separate dry-run preview V4.1: ${targetPath}`);
console.log(`- File Size: ${stat4_1.size} bytes`);
console.log(`- Total Rows: ${v4_1Rows.length + 1} (including header)`);
console.log(`- SHA-256: ${v4_1Sha}`);

// Full Reconciliation Audit: V4 vs V4.1
function auditDataset(rows) {
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

const audit4 = auditDataset(v4.rows);
const audit4_1 = auditDataset(v4_1Rows);

console.log('\n--- 35 ACCOUNT BALANCES COMPARISON (V4 vs V4.1) ---');
const allAccounts = Object.keys(audit4.bal).sort();
allAccounts.forEach(acct => {
  const b4 = audit4.bal[acct] || 0;
  const b4_1 = audit4_1.bal[acct] || 0;
  const diff = b4_1 - b4;
  console.log(`${acct.padEnd(25)} | V4: ₹${b4.toFixed(2).padStart(12)} | V4.1: ₹${b4_1.toFixed(2).padStart(12)} | Diff: ₹${diff.toFixed(2)}`);
});

