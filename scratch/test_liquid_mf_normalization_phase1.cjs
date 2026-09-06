const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Read CSV
const csvPath = path.resolve('finman_2026-09-02.csv');
const rawContent = fs.readFileSync(csvPath, 'utf8');

function parseCSV(text) {
  // Regex parsing supporting RFC 4180
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
        i++; // skip escaped quote
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

console.log('=== RUNNING LIQUID MF NORMALIZATION PHASE 1 TEST SUITE ===');

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
assert.strictEqual(parentBal, 566484, 'Parent Liquid MF balance must be exactly Rs. 566,484');

// TEST 2: Ammi Cashback Attribution (All 7 rows)
const ammiCbIds = [
  '6199af0c-928d-4687-905d-e29db86e9b5e', // 7534 (Rs. 6,937)
  '5c0a02ba-03f9-44a0-99e9-425016dcefe9', // 7426 (Rs. 2,228)
  'ded72e1f-1ebd-4b56-ae5c-5b13113218c5', // 6906 (Rs. 1,922)
  'fa85c404-f94c-42e7-a314-61fdc8fe96f0', // 6427 (Rs. 3,338)
  'c24bc7db-14f6-4e3d-8752-f5a243d48d45', // 6125 (Rs. 2,144)
  'c4843272-3289-4a41-ac3b-59e552377384', // 4901 (Rs. 11,801)
  'a710ce84-4979-4d31-8537-6060225dd292', // 4232 (Rs. 7,630)
];
let totalCbAmt = 0;
for (const cid of ammiCbIds) {
  const t = txns.find(r => r.ID === cid);
  assert(t, `Cashback txn ${cid} must exist`);
  const resolved = resolveInvestmentSubAccount(t, 'Liquid Mutual Funds');
  assert.strictEqual(resolved, 'Ammi Groww', `Cashback txn ${cid} must resolve to Ammi Groww`);
  totalCbAmt += parseFloat(t.Amount);
}
console.log(`Total Ammi Cashback verified: Rs. ${totalCbAmt}`);
assert.strictEqual(totalCbAmt, 36000, 'Total Ammi Cashback must be exactly Rs. 36,000');

// TEST 3: Fareeda ETMoney Attribution
const fetmIds = [
  '6075a44d-a7af-4885-9ae7-8457c3420666', // 6404
  '70bc6df2-f39b-44e1-9795-1f4ca58f0b7b', // 6405
  '78fc33c4-33ee-49e5-ad8b-6d074f8fdf3a', // 6577
  'be603713-6b6d-48fe-be34-e9254f7b6d86', // 6578
  '7cf8ce64-9fc8-4790-b207-6cc616b79d57', // 6579
  'efdcd0b6-ffb7-4fe4-aa9b-05d26c010f61', // 6580
  '540accf4-76b8-4f76-abfd-02305949ddbd', // 6581
  '84310067-22a3-4714-9381-5bab6f16cde2', // 6582
];
for (const fid of fetmIds) {
  const t = txns.find(r => r.ID === fid);
  assert(t, `Fareeda ETMoney txn ${fid} must exist`);
  const resolved = resolveInvestmentSubAccount(t, 'Liquid Mutual Funds');
  assert.strictEqual(resolved, 'Fareeda ETMoney', `Txn ${fid} must resolve to Fareeda ETMoney`);
}
console.log(`All 8 Fareeda ETMoney transactions verified.`);

// TEST 4: Line 7247 Memo Preservation
const t7247 = txns.find(r => r.ID === '12c5c903-06d5-40b5-b87c-8427ba6d7788');
assert(t7247, 'Line 7247 must exist');
assert.strictEqual(t7247.SubAccount, 'Fareeda Groww', 'Line 7247 SubAccount must remain Fareeda Groww');
assert.strictEqual(parseFloat(t7247.Amount), 0, 'Line 7247 Amount must remain 0');

// TEST 5: SBI RD Preservation
const t12110 = txns.find(r => r.ID === '794fc457-4e32-4fc7-a8fa-8fd4ae22ac33');
assert(t12110, 'Line 12110 must exist');
assert.strictEqual(parseFloat(t12110.Amount), 56954, 'Line 12110 Amount must remain 56,954');
assert.strictEqual(t12110.ToAccount, 'SBI RD', 'Line 12110 ToAccount must remain SBI RD');

const sbiRdBal = computeParentBalance(txns, 'SBI RD');
console.log(`SBI RD Balance: Rs. ${sbiRdBal}`);
assert.strictEqual(sbiRdBal, 56954, 'SBI RD balance must remain exactly Rs. 56,954');

// TEST 6: Fahim Memo (Line 12411) & FD Interest Memo (Line 8529 & 7931)
const t12411 = txns.find(r => r.ID === 'e7eb3f2c-97d0-4d6a-9ad2-52c6916cd21e');
assert(t12411, 'Line 12411 must exist');
assert.strictEqual(parseFloat(t12411.Amount), 0, 'Line 12411 must remain 0');

const t8529 = txns.find(r => r.ID === '4eba4c52-aae7-4385-a9b2-71875364fd1c');
assert(t8529, 'Line 8529 must exist');
assert.strictEqual(parseFloat(t8529.Amount), 0, 'Line 8529 must remain 0');

const t7931 = txns.find(r => r.ID === '22459d2c-3d16-4803-b8fe-24122e3c35fb');
assert(t7931, 'Line 7931 must exist');
assert.strictEqual(parseFloat(t7931.Amount), 0, 'Line 7931 must remain 0');

// TEST 7: Subaccount Engine Balances
const fgBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Fareeda Groww');
const fetmBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Fareeda ETMoney');
const agBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Ammi Groww');
const aketmBal = computeSubAccountBalance(txns, 'Liquid Mutual Funds', 'Ak ETMoney');

console.log(`Engine Balances:`);
console.log(`  Ammi Groww:      Rs. ${agBal}`);
console.log(`  Fareeda Groww:   Rs. ${fgBal}`);
console.log(`  Fareeda ETMoney: Rs. ${fetmBal}`);
console.log(`  Ak ETMoney:      Rs. ${aketmBal}`);
assert.strictEqual(agBal, 219490, 'Ammi Groww balance must be Rs. 219,490 (197,915 + 21,575)');

console.log('\n========================================');
console.log('ALL PHASE 1 INVARIANTS AND REGRESSION TESTS PASSED 100%!');
console.log('========================================');

