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

console.log('--- LOCATE TARGET ROWS IN V4.2 ---');
let row100 = null;
let row600 = null;

v4_2.rows.forEach((r, idx) => {
  if (r.ID === '5332c24d-477b-4019-978c-2365fc228078') {
    row100 = { idx, rowNum: idx + 1, data: r };
    console.log(`Found ₹100 row: Row ${idx + 1} | ID: ${r.ID} | Date: ${r.Date} | From: ${r.Account || r.FromAccount} | Note: "${r.Note}"`);
  }
  if (r.ID === 'fcd85e24-0528-412e-87df-dc7430d74650') {
    row600 = { idx, rowNum: idx + 1, data: r };
    console.log(`Found ₹600 row: Row ${idx + 1} | ID: ${r.ID} | Date: ${r.Date} | From: ${r.Account || r.FromAccount} | Note: "${r.Note}"`);
  }
});

// Update ONLY these two rows in V4.2
const beforeAfter = [];

const finalRows = v4_2.rows.map((r, idx) => {
  if (r.ID === '5332c24d-477b-4019-978c-2365fc228078') {
    const before = { ...r };
    r['Income/Expense'] = 'Expense';
    r.Account = 'Cash';
    r.FromAccount = 'Cash';
    r.ToAccount = '';
    r.Category = 'To Home';
    r.Subcategory = 'House Members';
    r.Note = 'to father';
    r.Description = 'Transfer to Father for Motilal Oswal Nifty Next 50 SIP | Father\'s MF payment';
    r.AccountingClassification = 'REAL_CASH_MOVEMENT';
    beforeAfter.push({ name: '₹100 Cash Payment', rowNum: idx + 1, before, after: { ...r } });
  } else if (r.ID === 'fcd85e24-0528-412e-87df-dc7430d74650') {
    const before = { ...r };
    r['Income/Expense'] = 'Expense';
    r.Account = 'Canara';
    r.FromAccount = 'Canara';
    r.ToAccount = '';
    r.Category = 'To Home';
    r.Subcategory = 'House Members';
    r.Note = 'to father';
    r.Description = 'Transfer to Father for Motilal Oswal Nifty Next 50 SIP | Father\'s MF payment';
    r.AccountingClassification = 'REAL_CASH_MOVEMENT';
    beforeAfter.push({ name: '₹600 Canara Payment', rowNum: idx + 1, before, after: { ...r } });
  }
  return r;
});

const finalContent = stringifyCSV(v4_2.headers, finalRows);
const targetPath = 'scratch/finman_reconstructed_master_preview_v4_2.csv';
fs.writeFileSync(targetPath, finalContent, 'utf8');

const finalSha = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
console.log(`\nUpdated ${targetPath} successfully!`);
console.log(`SHA-256 Checksum: ${finalSha}`);

// Full Validation Checks
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

const audit = calcBalances(finalRows);
console.log('\n--- VALIDATION RESULTS ---');
console.log(`1. Total Rows: ${finalRows.length} (0 added, 0 deleted)`);
console.log(`2. Cash Balance: ₹${audit.bal['Cash'].toFixed(2)}`);
console.log(`3. Canara Balance: ₹${audit.bal['Canara'].toFixed(2)}`);
console.log(`4. Liquid Mutual Funds Balance: ₹${audit.bal['Liquid Mutual Funds'].toFixed(2)}`);
console.log(`5. Mutual Funds Tax Saver Balance: ₹${audit.bal['Mutual Funds Tax Saver'].toFixed(2)}`);
console.log(`6. Share Market Balance: ₹${audit.bal['Share Market'].toFixed(2)}`);

fs.writeFileSync('scratch/final_two_rows_diff.json', JSON.stringify(beforeAfter, null, 2), 'utf8');

