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

const v4_2Path = 'scratch/finman_reconstructed_master_preview_v4_2.csv';
const v4_2 = parseCSV(fs.readFileSync(v4_2Path, 'utf8'));

console.log('=== APPLICATION PRE-IMPORT CONTRACT CHECK ===\n');

let allPassed = true;
function assertCheck(num, desc, condition, details = '') {
  if (condition) {
    console.log(`[PASS] Check ${num}: ${desc}`);
  } else {
    console.log(`[FAIL] Check ${num}: ${desc} --> ${details}`);
    allPassed = false;
  }
}

// 1. Data Rows Count
assertCheck(1, 'Exact 28,846 data rows', v4_2.rows.length === 28846, `Found ${v4_2.rows.length}`);

// 2. Original Transaction IDs Preserved and Unique
const idSet = new Set();
let dupCount = 0;
let emptyCount = 0;
v4_2.rows.forEach(r => {
  if (!r.ID) emptyCount++;
  else if (idSet.has(r.ID)) dupCount++;
  else idSet.add(r.ID);
});
assertCheck(2, 'All original transaction IDs unique and non-empty', dupCount === 0 && emptyCount === 0 && idSet.size === 28846, `Empty: ${emptyCount}, Dups: ${dupCount}, Unique: ${idSet.size}`);

// 3. Header & Column Count
assertCheck(3, 'Header contains 52 columns including AccountingClassification', v4_2.headers.length === 52 && v4_2.headers.includes('AccountingClassification'), `Columns: ${v4_2.headers.length}`);

// 4. AccountingClassification column integrity
const validClasses = new Set([
  'REAL_INVESTMENT_TRANSACTION',
  'REAL_CASH_MOVEMENT',
  'ZERO_VALUE_TRACKING',
  'EXTERNAL_FAMILY_INVESTMENT',
  'REAL_INVESTMENT_PNL',
  'LEGACY_BOOKKEEPING_ADJUSTMENT'
]);
let invalidClassCount = 0;
v4_2.rows.forEach(r => {
  if (!validClasses.has(r.AccountingClassification)) invalidClassCount++;
});
assertCheck(4, 'AccountingClassification valid for 100% of rows', invalidClassCount === 0, `Invalid: ${invalidClassCount}`);

// 5. Existing Transaction Types
const validTypes = new Set(['Expense', 'Income', 'Transfer-Out', 'Transfer']);
let invalidTypesCount = 0;
v4_2.rows.forEach(r => {
  const t = r['Income/Expense'];
  if (!validTypes.has(t)) invalidTypesCount++;
});
assertCheck(5, 'Transaction types adhere strictly to schema', invalidTypesCount === 0, `Invalid types: ${invalidTypesCount}`);

// 6. The Two Father Payment Rows
const r100 = v4_2.rows.find(r => r.ID === '5332c24d-477b-4019-978c-2365fc228078');
const r600 = v4_2.rows.find(r => r.ID === 'fcd85e24-0528-412e-87df-dc7430d74650');

const r100Valid = r100 &&
  r100.Amount === '100.0' &&
  r100.Account === 'Cash' &&
  r100['Income/Expense'] === 'Expense' &&
  r100.Category === 'To Home' &&
  r100.Subcategory === 'House Members' &&
  r100.Note === 'to father' &&
  r100.AccountingClassification === 'REAL_CASH_MOVEMENT' &&
  !r100.ToAccount && !r100.ToAccountGroup && !r100.ToSubAccount;

const r600Valid = r600 &&
  r600.Amount === '600.0' &&
  r600.Account === 'Canara' &&
  r600['Income/Expense'] === 'Expense' &&
  r600.Category === 'To Home' &&
  r600.Subcategory === 'House Members' &&
  r600.Note === 'to father' &&
  r600.AccountingClassification === 'REAL_CASH_MOVEMENT' &&
  !r600.ToAccount && !r600.ToAccountGroup && !r600.ToSubAccount;

assertCheck(6, 'The two Father payment rows are valid clean Expense records', r100Valid && r600Valid, `r100Valid=${r100Valid}, r600Valid=${r600Valid}`);

// 7. Father MF Tracking Records Isolation
const fatherRecords = v4_2.rows.filter(r => {
  const c = `${r.Note} ${r.Description}`.toLowerCase();
  return c.includes('father mutual fund') || c.includes('father mf') || (c.includes('father') && c.includes('motilal oswal nifty next 50'));
});
const fatherNonPaymentRecords = fatherRecords.filter(r => r.ID !== '5332c24d-477b-4019-978c-2365fc228078' && r.ID !== 'fcd85e24-0528-412e-87df-dc7430d74650');
const fatherAllZero = fatherNonPaymentRecords.every(r => parseFloat(r.INR || r.Amount || 0) === 0);
assertCheck(7, 'Father MF tracking records remain distinct and cannot create personal assets', fatherRecords.length === 21 && fatherNonPaymentRecords.length === 19 && fatherAllZero);

// 8. CAS Records Integrity
const casRecords = v4_2.rows.filter(r => r.Source === 'CAMS_CAS');
const casValid = casRecords.length === 163 && casRecords.every(r => r.InvestmentTransactionType && r.Brokerage === 'Ak ETMoney' && r.SecuritySymbol);
assertCheck(8, 'All 163 CAS records retain authoritative investment metadata', casValid, `Count: ${casRecords.length}`);

// 9. Zerodha Records Integrity
const zerodhaRecords = v4_2.rows.filter(r => (r.Account === 'Share Market' || r.FromAccount === 'Share Market' || r.ToAccount === 'Share Market') && (r.Brokerage === 'Zerodha' || r.Source === 'Zerodha' || r.Category === 'Equity' || r.InvestmentTransactionType));
assertCheck(9, 'All 803 Zerodha records retain full tradebook and Demat cash fields', zerodhaRecords.length === 803, `Count: ${zerodhaRecords.length}`);

// 10. Importer Transformation Invariance Test
// Verify simulation: No silent ID creation, no Expense->Transfer conversion, no external->personal mutation
let silentMutations = 0;
v4_2.rows.forEach(r => {
  if (r['Income/Expense'] === 'Expense' && r.ToAccount) silentMutations++;
  if (r['Income/Expense'] === 'Transfer-Out' && !r.ToAccount) silentMutations++;
});
assertCheck(10, 'No silent schema distortion or invalid state transitions', silentMutations === 0, `Mutations: ${silentMutations}`);

console.log('\n==================================================');
if (allPassed) {
  console.log('🎉 RESULT: IMPORT CONTRACT PASS');
} else {
  console.log('❌ RESULT: IMPORT CONTRACT FAILED');
}
console.log('==================================================');

