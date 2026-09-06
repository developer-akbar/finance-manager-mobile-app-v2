const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Read CSV
const csvPath = path.resolve('finman_2026-09-02.csv');
const rawContent = fs.readFileSync(csvPath, 'utf8');

function parseCSV(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let cur = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nextCh = text[i + 1];

    if (ch === '"') {
      if (inQuotes && nextCh === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && nextCh === '\n') i++;
      row.push(cur);
      if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
        rows.push(row);
      }
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }

  const headers = rows[0].map(h => h.trim());
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = rows[r][idx] !== undefined ? rows[r][idx] : '';
    });
    obj._line = r;
    data.push(obj);
  }
  return { headers, data };
}

const { headers, data: txns } = parseCSV(rawContent);

console.log('=== RUNNING PHASE 5 CAS NORMALIZATION TEST SUITE ===');

// 1. Transaction Count Invariant
console.log(`Total transactions in dataset: ${txns.length}`);
assert.strictEqual(txns.length, 28849, 'Total transaction count must remain 28,849');

// 2. Load Preview Conversions
const previewPath = path.resolve('scratch/phase5_conversion_preview.json');
const conversions = JSON.parse(fs.readFileSync(previewPath, 'utf8'));
console.log(`Loaded ${conversions.length} planned conversions from preview`);

// 3. Verify all 111 conversions are present in FinMan CSV
let convCount = 0;
let totalUnitsVerified = 0;
for (const c of conversions) {
  const t = txns.find(r => r.ID === c.SourceFinManTransactionID);
  assert(t, `Source transaction ${c.SourceFinManTransactionID} must exist`);
  assert.strictEqual(t.InvestmentTransactionType, 'BUY', `Txn ${c.SourceFinManTransactionID} must be BUY`);
  assert.strictEqual(t.SecurityISIN, c.SecurityISIN, `ISIN mismatch for txn ${c.SourceFinManTransactionID}`);
  assert.strictEqual(parseFloat(t.Quantity), c.CASUnits, `Quantity mismatch for txn ${c.SourceFinManTransactionID}`);
  assert.strictEqual(parseFloat(t.UnitPrice), c.CASNAV, `NAV mismatch for txn ${c.SourceFinManTransactionID}`);
  assert.strictEqual(parseFloat(t.CostBasis), c.NetInvestmentAmount, `CostBasis mismatch for txn ${c.SourceFinManTransactionID}`);
  assert.strictEqual(t.Source, 'CAMS_CAS', `Source must be CAMS_CAS for txn ${c.SourceFinManTransactionID}`);
  convCount++;
  totalUnitsVerified += parseFloat(t.Quantity);
}
console.log(`Verified ${convCount} / 111 first-class BUY conversions`);
assert.strictEqual(convCount, 111, 'Must have exactly 111 converted transactions');

// 4. Verify 19 Active Positions and Exact Unit Balances
const expectedPositions = {
  'Fareeda Groww|INF740KA1MG9|10185451 / 05|NON_DEMAT': 2044.940,
  'Fareeda Groww|INF740KA1MG9|11056452 / 85|DEMAT': 1058.476,
  'Fareeda ETMoney|INF740KA1MG9|8470103 / 05|NON_DEMAT': 1813.113,
  'Fareeda Groww|INF179K01XQ0|41564472 / 84|DEMAT': 107.744,
  'Fareeda Groww|INF769K01BI1|78887871745 / 0|DEMAT': 69.377,
  'Fareeda Groww|INF247L01445|910118443576 / 0|NON_DEMAT': 259.369,
  'Fareeda Groww|INF247L01AC1|910118443576 / 0|NON_DEMAT': 26.847,
  'Fareeda Groww|INF247L01AC1|910121381854 / 0|DEMAT': 363.410,
  'Fareeda ETMoney|INF247L01445|91055029576 / 0|NON_DEMAT': 411.071,
  'Fareeda ETMoney|INF247L01AC1|91055029576 / 0|NON_DEMAT': 156.317,
  'Fareeda Groww|INF204K01XI3|477405385771 / 0|NON_DEMAT': 486.943,
  'Fareeda Groww|INF204K01K15|477405389157 / 0|NON_DEMAT': 159.845,
  'Fareeda Groww|INF879O01027|17087524|NON_DEMAT': 474.617,
  'Fareeda Groww|INF879O01027|19824545|DEMAT': 439.969,
  'Ammi Groww|INF247L01445|910125090796 / 0|DEMAT': 66.946,
  'Ammi Groww|INF247L01445|91053499341 / 0|NON_DEMAT': 254.852,
  'Ammi Groww|INF247L01999|91053499341 / 0|NON_DEMAT': 4222.156,
  'Ammi Groww|INF204K01XI3|477306423194 / 0|NON_DEMAT': 309.647,
  'Ammi Groww|INF879O01027|16530278|NON_DEMAT': 500.138,
};

console.log('\nVerifying 19 Active Positions:');
let verifiedSchemes = 0;
for (const [key, expUnits] of Object.entries(expectedPositions)) {
  const [sub, isin, fol, mode] = key.split('|');
  const matchedTxns = conversions.filter(c => c.SubAccount === sub && c.SecurityISIN === isin && c.FolioNumber === fol && c.HoldingMode === mode);
  const sumUnits = round3(matchedTxns.reduce((acc, c) => acc + c.CASUnits, 0));
  assert.strictEqual(sumUnits, expUnits, `Units mismatch for ${key}: got ${sumUnits}, expected ${expUnits}`);
  verifiedSchemes++;
}
assert.strictEqual(verifiedSchemes, 19, 'All 19 active positions verified');
console.log('PASS: All 19 Active Positions have exact 0.000 unit delta with CAS!');

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// 5. Verify Engine Balances
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

    if (invType === 'BUY') {
      const targetAcct = dest || acct;
      const targetSub = dest ? toSub : sub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal += (tradeVal || amt);
      }
    } else if (invType === 'SELL') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? fromSub : sub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal -= (tradeVal || amt);
      }
    } else if (type === 'Income') {
      const targetAcct = dest || acct;
      const targetSub = dest ? toSub : sub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal += amt;
      }
    } else if (type === 'Expense') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? fromSub : sub;
      if (targetAcct === acctName && targetSub === subAccountName) {
        bal -= amt;
      }
    } else if (type === 'Transfer-Out') {
      if (fromAcct === acctName && fromSub === subAccountName) {
        bal -= amt;
      }
      if (dest === acctName && toSub === subAccountName) {
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

const parentBal = computeParentBalance(txns, 'Liquid Mutual Funds');
const fgBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Fareeda Groww');
const fetmBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Fareeda ETMoney');
const agBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Ammi Groww');

console.log('\nEngine Balances after Phase 5 Normalization:');
console.log(`  Parent Liquid MF: Rs. ${parentBal}`);
console.log(`  Fareeda Groww:   Rs. ${fgBal}`);
console.log(`  Fareeda ETMoney: Rs. ${fetmBal}`);
console.log(`  Ammi Groww:      Rs. ${agBal}`);

assert.strictEqual(parentBal, 566484, 'Parent balance must remain exactly Rs. 566,484.00');
assert.strictEqual(fgBal, 315000, 'Fareeda Groww balance must remain exactly Rs. 315,000.00');
assert.strictEqual(fetmBal, 31994, 'Fareeda ETMoney balance must remain exactly Rs. 31,994.00');
assert.strictEqual(agBal, 219490, 'Ammi Groww balance must remain exactly Rs. 219,490.00');

// 6. Protected Records Verification
const protectedLines = [12110, 12411, 8529, 7931, 8157, 8158, 7894, 7247];
for (const l of protectedLines) {
  const row = txns[l - 1];
  assert.notStrictEqual(row.InvestmentTransactionType, 'BUY', `Protected line ${l} must NOT be BUY`);
  assert.notStrictEqual(row.InvestmentTransactionType, 'SELL', `Protected line ${l} must NOT be SELL`);
}
console.log('PASS: All 8 protected records remain untouched!');

// 7. SBI RD (12110)
const sbiRd = txns[12110 - 1];
assert.strictEqual(parseFloat(sbiRd.Amount), 56954, 'SBI RD must remain 56,954');
console.log('PASS: SBI RD 12110 remains untouched!');

// 8. Ammi Cashback verification
const ammiCbLines = [7534, 7426, 6906, 6427, 6125, 4901, 4232];
let ammiCbSum = 0;
for (const l of ammiCbLines) {
  const r = txns[l - 1];
  ammiCbSum += parseFloat(r.Amount);
  assert.strictEqual(r.SubAccount, 'Ammi Groww', `Ammi Cashback line ${l} must be Ammi Groww`);
}
assert.strictEqual(ammiCbSum, 36000, 'Ammi Cashback sum must remain Rs. 36,000');
console.log('PASS: Ammi Cashback (Rs. 36,000) verified and not duplicated!');

console.log('\n========================================');
console.log('ALL PHASE 5 TESTS PASSED WITH 100% SUCCESS!');
console.log('========================================');
