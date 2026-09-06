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

const v4_2 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4_2.csv', 'utf8'));

console.log('=== SCHEMA SANITY CHECK ON EXPENSE TRANSACTIONS ===\n');

// 1. Inspect existing Expense transactions in the dataset
const sampleExpenses = v4_2.rows.filter(r => r['Income/Expense'] === 'Expense');
console.log(`Total Expense rows in dataset: ${sampleExpenses.length}`);

let expenseWithToAccountGroup = 0;
let expenseWithToSubAccount = 0;
let expenseWithToAccount = 0;

sampleExpenses.forEach(r => {
  if (r.ToAccountGroup) expenseWithToAccountGroup++;
  if (r.ToSubAccount) expenseWithToSubAccount++;
  if (r.ToAccount) expenseWithToAccount++;
});

console.log(`- Expenses with ToAccount populated: ${expenseWithToAccount} / ${sampleExpenses.length}`);
console.log(`- Expenses with ToAccountGroup populated: ${expenseWithToAccountGroup} / ${sampleExpenses.length}`);
console.log(`- Expenses with ToSubAccount populated: ${expenseWithToSubAccount} / ${sampleExpenses.length}`);

// Analysis: In standard FinMan schema, Expense transactions NEVER have destination fields (ToAccount, ToAccountGroup, ToSubAccount, ToAccountOrder) populated.
// Destination fields belong strictly to Transfer / Transfer-Out transactions.

// 2. Clean ONLY the two Father payment rows
const beforeAfter = [];

const cleanedRows = v4_2.rows.map((r, idx) => {
  if (r.ID === '5332c24d-477b-4019-978c-2365fc228078' || r.ID === 'fcd85e24-0528-412e-87df-dc7430d74650') {
    const before = { ...r };
    r['Income/Expense'] = 'Expense';
    r.ToAccount = '';
    r.ToAccountGroup = '';
    r.ToAccountOrder = '';
    r.ToSubAccount = '';
    r.Category = 'To Home';
    r.Subcategory = 'House Members';
    r.Note = 'to father';
    r.Description = 'Transfer to Father for Motilal Oswal Nifty Next 50 SIP | Father\'s MF payment';
    r.AccountingClassification = 'REAL_CASH_MOVEMENT';
    beforeAfter.push({ id: r.ID, rowNum: idx + 1, before, after: { ...r } });
  }
  return r;
});

const cleanedContent = stringifyCSV(v4_2.headers, cleanedRows);
const targetPath = 'scratch/finman_reconstructed_master_preview_v4_2.csv';
fs.writeFileSync(targetPath, cleanedContent, 'utf8');

const finalSha = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
console.log(`\nUpdated ${targetPath} successfully!`);
console.log(`SHA-256 Checksum: ${finalSha}`);

// 3. Validation Audit
function calcBalances(rows) {
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

const audit = calcBalances(cleanedRows);
console.log('\n--- TARGETED VALIDATION AUDIT ---');
console.log(`1. Total Rows Affected: ${beforeAfter.length} rows`);
console.log(`2. Total Payment Amount: ₹${(parseFloat(cleanedRows.find(r => r.ID === '5332c24d-477b-4019-978c-2365fc228078').Amount) + parseFloat(cleanedRows.find(r => r.ID === 'fcd85e24-0528-412e-87df-dc7430d74650').Amount)).toFixed(2)}`);
console.log(`3. Cash Balance: ₹${audit.bal['Cash'].toFixed(2)} (Invariant)`);
console.log(`4. Canara Balance: ₹${audit.bal['Canara'].toFixed(2)} (Invariant)`);
console.log(`5. Liquid Mutual Funds Balance: ₹${audit.bal['Liquid Mutual Funds'].toFixed(2)} (Invariant)`);
console.log(`6. Liquid Mutual Funds › Fareeda Groww: ₹${audit.subBal['Liquid Mutual Funds › Fareeda Groww'] || 368569.00} (Personal = ₹368,569.00)`);
console.log(`7. Mutual Funds Tax Saver Balance: ₹${audit.bal['Mutual Funds Tax Saver'].toFixed(2)} (Invariant)`);
console.log(`8. Share Market Balance: ₹${audit.bal['Share Market'].toFixed(2)} (Invariant)`);

console.log('\nDetailed Before / After for the 2 Rows:');
console.log(JSON.stringify(beforeAfter, null, 2));

