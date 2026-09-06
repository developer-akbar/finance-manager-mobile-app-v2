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

console.log('=== RUNNING LIQUID MF NORMALIZATION PHASE 2 TEST SUITE ===');

// 1. Transaction count
console.log(`Total transactions in dataset: ${txns.length}`);
assert.strictEqual(txns.length, 28849, 'Total transaction count must be exactly 28,849');

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

// TEST 1: Parent Balance Invariant
const parentBal = computeParentBalance(txns, 'Liquid Mutual Funds');
console.log(`Parent Liquid MF Balance: Rs. ${parentBal}`);
assert.strictEqual(parentBal, 566484, 'Parent Liquid MF balance must remain exactly Rs. 566,484');

// TEST 2: The 17 DSP Purchase Rows
const dsp17Ids = [
  '5121808e-3569-49c4-b5dd-135065db76ca',
  '35199c20-83be-4d6b-b3ad-127241c5a308',
  '7c9fdf01-8788-457c-b2a6-b17ff1ebb310',
  '637da1f3-2676-4e23-8596-6934346b58b5',
  'ca401ed4-50f4-45a6-84aa-2be06b722427',
  'b8d23e14-8e24-40d3-bf7d-905ddc848562',
  'a8952038-e29e-467e-a9f0-5f100ee49fef',
  '10d793a1-f4af-41eb-828e-7d41865d3cd2',
  '841de93e-0356-4c69-bd89-8aed6c6948bd',
  '4992f3ec-ec7f-4e8a-abd0-41d5dea65cbb',
  '7ac21162-604a-43c0-a868-e23c28cbdf2c',
  'acd961ec-2be7-4c82-b4bb-59d75e4ae555',
  '5aaf60e6-2ece-4dc6-9a0c-deeb97ed982e',
  'ca66768f-b994-4aa2-9ab2-598daf44fb71',
  '67e2552f-b1b0-4fc5-9819-011fc792bc58',
  'e9b70da8-db53-4ec9-a0a8-56908bd148d1',
  '6e55e5ac-9d2e-47c7-a16e-71c56452c3ee',
];
let totalDspMoved = 0;
for (const id of dsp17Ids) {
  const t = txns.find(r => r.ID === id);
  assert(t, `DSP purchase txn ${id} must exist`);
  assert.strictEqual(t.SubAccount, 'Fareeda ETMoney', `DSP purchase txn ${id} SubAccount must be Fareeda ETMoney`);
  assert.strictEqual(t.ToSubAccount, 'Fareeda ETMoney', `DSP purchase txn ${id} ToSubAccount must be Fareeda ETMoney`);
  totalDspMoved += parseFloat(t.Amount);
}
console.log(`Verified 17 DSP purchases moved: Rs. ${totalDspMoved}`);
assert.strictEqual(totalDspMoved, 298000, 'Sum of 17 DSP purchases must be exactly Rs. 298,000');

// TEST 3: Subaccount Engine Balances
const fgBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Fareeda Groww');
const fetmBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Fareeda ETMoney');
const agBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Ammi Groww');
const aketmBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Ak ETMoney');

console.log(`Engine Balances after Phase 2:`);
console.log(`  Fareeda Groww:   Rs. ${fgBal}`);
console.log(`  Fareeda ETMoney: Rs. ${fetmBal}`);
console.log(`  Ammi Groww:      Rs. ${agBal}`);
console.log(`  Ak ETMoney:      Rs. ${aketmBal}`);

assert.strictEqual(fgBal, 315000, 'Fareeda Groww balance must be exactly Rs. 315,000.00');
assert.strictEqual(fetmBal, 31994, 'Fareeda ETMoney balance must be exactly Rs. 31,994.00');
assert.strictEqual(agBal, 219490, 'Ammi Groww balance must be exactly Rs. 219,490.00');
assert.strictEqual(aketmBal, -7570.67999999998, 'Ak ETMoney balance must be unchanged');

// TEST 4: Untouched Invariants
const t12110 = txns.find(r => r.ID === '794fc457-4e32-4fc7-a8fa-8fd4ae22ac33');
assert.strictEqual(parseFloat(t12110.Amount), 56954, 'Line 12110 Amount must remain 56,954');
const sbiRdBal = computeParentBalance(txns, 'SBI RD');
assert.strictEqual(sbiRdBal, 56954, 'SBI RD balance must remain exactly Rs. 56,954');

const t7247 = txns.find(r => r.ID === '12c5c903-06d5-40b5-b87c-8427ba6d7788');
assert.strictEqual(t7247.SubAccount, 'Fareeda Groww', 'Line 7247 SubAccount must remain Fareeda Groww');
assert.strictEqual(parseFloat(t7247.Amount), 0, 'Line 7247 Amount must remain 0');

console.log('\n========================================');
console.log('ALL PHASE 2 INVARIANTS AND REGRESSION TESTS PASSED 100%!');
console.log('========================================');

