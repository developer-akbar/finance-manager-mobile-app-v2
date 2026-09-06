const fs = require('fs');
const crypto = require('crypto');

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

  if (records.length < 2) return [];
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

const v2Raw = fs.readFileSync('scratch/finman_CAS_enriched_master_preview_v2.csv', 'utf8');
const { headers, rows } = parseCSV(v2Raw);

console.log(`Loaded ${rows.length} rows from V2 CSV.`);

// Ensure Classification / Tag metadata headers exist if not already present
let newHeaders = [...headers];
if (!newHeaders.includes('AccountingClassification')) {
  newHeaders.push('AccountingClassification');
}

// 13 known historical adjustment rows:
// 2018 Share Market ₹10k cluster: 25130, 25170, 25171, 25172, 25187, 25311, 25321, 25588
// 2020 FTMF ₹2,727 cluster: 20472, 20473, 20474, 20475, 20476
const adjustmentRows = new Set([25130, 25170, 25171, 25172, 25187, 25311, 25321, 25588, 20472, 20473, 20474, 20475, 20476]);

const reconstructedRows = rows.map((r, idx) => {
  const rowNum = idx + 1;
  const newRow = { ...r };

  const note = (r.Note || '').toLowerCase();
  const desc = (r.Description || '').toLowerCase();
  const cat = (r.Category || '').toLowerCase();
  const subcat = (r.Subcategory || '').toLowerCase();
  const c = `${note} ${desc} ${cat} ${subcat}`;

  if (adjustmentRows.has(rowNum)) {
    newRow.AccountingClassification = 'LEGACY_BOOKKEEPING_ADJUSTMENT';
  } else if (c.includes('father mutual fund') || c.includes('father mf') || (c.includes('father') && c.includes('mutual fund'))) {
    newRow.AccountingClassification = 'EXTERNAL_FAMILY_INVESTMENT';
  } else if (r.Source === 'CAMS_CAS' || r.Source === 'Zerodha' || r.InvestmentTransactionType) {
    newRow.AccountingClassification = 'REAL_INVESTMENT_TRANSACTION';
  } else if (parseFloat(r.INR || r.Amount || 0) === 0) {
    newRow.AccountingClassification = 'ZERO_VALUE_TRACKING';
  } else {
    newRow.AccountingClassification = 'REAL_CASH_MOVEMENT';
  }

  return newRow;
});

const v3Content = stringifyCSV(newHeaders, reconstructedRows);
const targetPath = 'scratch/finman_reconstructed_master_preview_v3.csv';
fs.writeFileSync(targetPath, v3Content, 'utf8');

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
const stat = fs.statSync(targetPath);

console.log(`\nSuccessfully created separate dry-run file: ${targetPath}`);
console.log(`- File Size: ${stat.size} bytes`);
console.log(`- Total Rows: ${reconstructedRows.length + 1} (including header)`);
console.log(`- SHA-256: ${sha256}`);

// Run Balance Invariance Check
const origBalances = {};
const newBalances = {};

function computeBalances(data, targetObj) {
  data.forEach(t => {
    const type = t['Income/Expense'];
    const amt = parseFloat(t.INR || t.Amount || 0);
    if (isNaN(amt) || amt === 0) return;

    const acct = t.Account || t.FromAccount;
    const toAcct = t.ToAccount;
    const sub = t.SubAccount || t.FromSubAccount;
    const toSub = t.ToSubAccount;

    if (type === 'Income') {
      if (acct) targetObj[acct] = (targetObj[acct] || 0) + amt;
      if (acct && sub) {
        const k = `${acct} › ${sub}`;
        targetObj[k] = (targetObj[k] || 0) + amt;
      }
    } else if (type === 'Expense') {
      if (acct) targetObj[acct] = (targetObj[acct] || 0) - amt;
      if (acct && sub) {
        const k = `${acct} › ${sub}`;
        targetObj[k] = (targetObj[k] || 0) - amt;
      }
    } else if (type === 'Transfer-Out') {
      if (acct) targetObj[acct] = (targetObj[acct] || 0) - amt;
      if (toAcct) targetObj[toAcct] = (targetObj[toAcct] || 0) + amt;

      if (acct && sub) {
        const k = `${acct} › ${sub}`;
        targetObj[k] = (targetObj[k] || 0) - amt;
      }
      if (toAcct && toSub) {
        const k = `${toAcct} › ${toSub}`;
        targetObj[k] = (targetObj[k] || 0) + amt;
      }
    }
  });
}

computeBalances(rows, origBalances);
computeBalances(reconstructedRows, newBalances);

console.log('\n--- BALANCE INVARIANCE VALIDATION ---');
let allMatch = true;
for (const [k, v] of Object.entries(origBalances)) {
  const newV = newBalances[k] || 0;
  const diff = Math.abs(v - newV);
  if (diff > 0.0001) {
    console.log(`❌ MISMATCH in ${k}: Orig=${v}, New=${newV}`);
    allMatch = false;
  }
}

if (allMatch) {
  console.log('✅ ALL ACCOUNT AND SUBACCOUNT BALANCES ARE 100% IDENTICAL TO THE PAISA!');
}

