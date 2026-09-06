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

const v4 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4.csv', 'utf8'));

console.log('=== V4.2 GENERATION WITH EXACT ROW IDs ===\n');

const changeReport = [];

const v4_2Rows = v4.rows.map((r, idx) => {
  const rowNum = idx + 1;
  const row = { ...r };

  if (row.ID === '5332c24d-477b-4019-978c-2365fc228078') { // Row 704: ₹100
    const orig = { ...r };
    row['Income/Expense'] = 'Expense';
    row.Account = 'Cash';
    row.FromAccount = 'Cash';
    row.ToAccount = '';
    row.Category = 'To Home';
    row.Subcategory = 'Father';
    row.Note = 'Father Mutual Fund payment';
    row.Description = 'Personal payment on behalf of Father for Motilal Oswal Nifty Next 50 SIP | Fareeda Groww';
    row.AccountingClassification = 'EXTERNAL_FAMILY_INVESTMENT';

    changeReport.push({
      id: row.ID,
      rowNum: rowNum,
      original: orig,
      proposed: row,
      reason: 'Reclassify transfer-to-MF into direct personal expense for Father to prevent inflating personal MF assets',
      evidence: 'Description explicitly notes "Motilal Oswal Nifty Next 50 Index 600 Fareeda Groww" with Note "Father Mutual Fund"',
      confidence: 'PROVEN (100%)',
      cashImpact: 'Invariant (Cash debited ₹100 in both V4 and V4.2)',
      investmentImpact: 'Removes ₹100 non-personal asset from Liquid MF / Fareeda Groww',
      pnlImpact: '₹0 impact on investment P&L; ₹100 personal family expense',
      ownershipImpact: '100% Father external asset; 0 personal asset'
    });
  } else if (row.ID === 'fcd85e24-0528-412e-87df-dc7430d74650') { // Row 211: ₹600
    const orig = { ...r };
    row['Income/Expense'] = 'Expense';
    row.Account = 'Canara';
    row.FromAccount = 'Canara';
    row.ToAccount = '';
    row.Category = 'To Home';
    row.Subcategory = 'Father';
    row.Note = 'Father Mutual Fund payment';
    row.Description = 'Personal payment on behalf of Father for Motilal Oswal Nifty Next 50 SIP | Fareeda Groww';
    row.AccountingClassification = 'EXTERNAL_FAMILY_INVESTMENT';

    changeReport.push({
      id: row.ID,
      rowNum: rowNum,
      original: orig,
      proposed: row,
      reason: 'Reclassify transfer-to-MF into direct personal expense for Father to prevent inflating personal MF assets',
      evidence: 'Description explicitly notes "Motilal Oswal Nifty Next 50 Index 600 Fareeda Groww" with Note "Father Mutual Fund"',
      confidence: 'PROVEN (100%)',
      cashImpact: 'Invariant (Canara debited ₹600 in both V4 and V4.2)',
      investmentImpact: 'Removes ₹600 non-personal asset from Liquid MF / Fareeda Groww',
      pnlImpact: '₹0 impact on investment P&L; ₹600 personal family expense',
      ownershipImpact: '100% Father external asset; 0 personal asset'
    });
  }

  return row;
});

const v4_2Content = stringifyCSV(v4.headers, v4_2Rows);
const targetPath = 'scratch/finman_reconstructed_master_preview_v4_2.csv';
fs.writeFileSync(targetPath, v4_2Content, 'utf8');

const v4_2Sha = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
const stat4_2 = fs.statSync(targetPath);

console.log(`Successfully created separate dry-run preview V4.2: ${targetPath}`);
console.log(`- File Size: ${stat4_2.size} bytes`);
console.log(`- Total Rows: ${v4_2Rows.length + 1} (including header)`);
console.log(`- SHA-256: ${v4_2Sha}`);

// Full 35 Account Reconciliation
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
const audit4_2 = auditDataset(v4_2Rows);

console.log('\n--- 35 ACCOUNT BALANCES COMPARISON (V4 vs V4.2) ---');
const allAccounts = Object.keys(audit4.bal).sort();
allAccounts.forEach(acct => {
  const b4 = audit4.bal[acct] || 0;
  const b4_2 = audit4_2.bal[acct] || 0;
  const diff = b4_2 - b4;
  console.log(`${acct.padEnd(25)} | V4: ₹${b4.toFixed(2).padStart(12)} | V4.2: ₹${b4_2.toFixed(2).padStart(12)} | Diff: ₹${diff.toFixed(2)}`);
});

// Key Subaccounts
console.log('\n--- KEY SUBACCOUNTS (V4 vs V4.2) ---');
const subKeys = [
  'Mutual Funds Tax Saver › Ak ETMoney',
  'Liquid Mutual Funds › Ak ETMoney',
  'Liquid Mutual Funds › Fareeda Groww',
  'Liquid Mutual Funds › Ammi Groww',
  'Share Market › Zerodha',
  'Share Market › Fareeda Groww'
];
subKeys.forEach(k => {
  const b4 = audit4.subBal[k] || 0;
  const b4_2 = audit4_2.subBal[k] || 0;
  const diff = b4_2 - b4;
  console.log(`${k.padEnd(40)} | V4: ₹${b4.toFixed(2).padStart(12)} | V4.2: ₹${b4_2.toFixed(2).padStart(12)} | Diff: ₹${diff.toFixed(2)}`);
});

fs.writeFileSync('scratch/v4_2_change_report.json', JSON.stringify(changeReport, null, 2), 'utf8');

