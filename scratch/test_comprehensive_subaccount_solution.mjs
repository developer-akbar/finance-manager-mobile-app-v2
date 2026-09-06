import fs from 'fs';
import { resolveInvestmentSubAccount } from '../src/utils/brokerageAccounting.js';

function parseCSV(text) {
  const records = [];
  let field = '';
  let fields = [];
  let inQ = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQ) {
      if (ch === '"' && next === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { fields.push(field); field = ''; i++; continue; }
    if (ch === '\n' || (ch === '\r' && next === '\n')) {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      if (ch === '\r') i++;
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.length > 1) records.push(fields);

  const headers = records[0].map(h => h.trim());
  const rows = [];
  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => row[h] = (rec[idx] || '').trim());
    rows.push(row);
  }
  return rows;
}

function parseDate(dStr) {
  if (!dStr) return new Date(0);
  const parts = dStr.split('/');
  if (parts.length === 3) {
    return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
  }
  return new Date(dStr);
}

function txnAmount(t) {
  return parseFloat(t.INR || t.Amount || 0);
}

function resolveInvestmentParent(txn) {
  if (!txn) return null;
  const invAcct = String(txn.InvestmentAccount || txn.investment_account || '').trim();
  const acct = String(txn.Account || txn.account || '').trim();
  const fromAcct = String(txn.FromAccount || txn.from_account || '').trim();
  const toAcct = String(txn.ToAccount || txn.to_account || '').trim();
  const cat = String(txn.Category || txn.category || '').trim();

  if (invAcct === 'Mutual Funds Tax Saver' || toAcct === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver' || fromAcct === 'Mutual Funds Tax Saver' || cat === 'Mutual Funds Tax Saver') {
    return 'Mutual Funds Tax Saver';
  }
  if (invAcct === 'Liquid Mutual Funds' || toAcct === 'Liquid Mutual Funds' || acct === 'Liquid Mutual Funds' || fromAcct === 'Liquid Mutual Funds' || cat === 'Liquid Mutual Funds') {
    return 'Liquid Mutual Funds';
  }
  if (invAcct === 'Share Market' || toAcct === 'Share Market' || acct === 'Share Market' || fromAcct === 'Share Market' || cat === 'Share Market' || cat === 'Equity') {
    return 'Share Market';
  }
  return null;
}

function isInvestmentTransactionForSubAccount(txn, parentAsset, subAccount) {
  if (!txn || !parentAsset || !subAccount) return false;
  const resolvedParent = resolveInvestmentParent(txn);
  if (resolvedParent !== parentAsset) return false;

  const resolvedPlatform = resolveInvestmentSubAccount(txn, parentAsset);
  return resolvedPlatform === subAccount;
}

function computeBalance(txns, acctName, subAccountName = null) {
  if (subAccountName) {
    let bal = 0;
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());

    for (const t of txns) {
      const amt = txnAmount(t);
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

  let bal = 0;
  for (const t of txns) {
    const amt = txnAmount(t);
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

const file = fs.existsSync('scratch/finman_reconstructed_master_preview_v4_2.csv')
  ? 'scratch/finman_reconstructed_master_preview_v4_2.csv'
  : 'scratch/finman_reconstructed_master_preview_v4.csv';

const baseRows = parseCSV(fs.readFileSync(file, 'utf8'));

console.log('--- Baseline Test ---');
const baseFareeda = computeBalance(baseRows, 'Liquid Mutual Funds', 'Fareeda Groww');
const baseAmmi = computeBalance(baseRows, 'Liquid Mutual Funds', 'Ammi Groww');
console.log('Baseline Fareeda Groww: ₹' + baseFareeda, baseFareeda === 368569 ? '✅ MATCH' : '❌ FAIL');
console.log('Baseline Ammi Groww:    ₹' + baseAmmi, baseAmmi === 197915 ? '✅ MATCH' : '❌ FAIL');

// Test 1: Fareeda BUY
const fareedaBuy = {
  Date: '02/09/2026',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  Category: 'Liquid Mutual Funds',
  'Income/Expense': 'Transfer-Out',
  INR: 100,
  Amount: '100',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  ToSubAccount: 'Fareeda Groww',
  FromSubAccount: '',
  Brokerage: 'Fareeda Groww',
  InvestmentTransactionType: 'BUY',
  TradeValue: 100,
  Note: 'DSP ELSS'
};

const rowsAfter1 = [...baseRows, fareedaBuy];
const fareedaAfter1 = computeBalance(rowsAfter1, 'Liquid Mutual Funds', 'Fareeda Groww');
console.log('\n--- Test 1: Fareeda Groww BUY ₹100 ---');
console.log('Fareeda Groww Result:   ₹' + fareedaAfter1, fareedaAfter1 === 368669 ? '✅ MATCH (Expected: ₹368,669)' : '❌ FAIL');

// Test 2: Ammi BUY
const ammiBuy = {
  Date: '02/09/2026',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  Category: 'Liquid Mutual Funds',
  'Income/Expense': 'Transfer-Out',
  INR: 100,
  Amount: '100',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Ammi Groww',
  ToSubAccount: 'Ammi Groww',
  FromSubAccount: '',
  Brokerage: 'Ammi Groww',
  InvestmentTransactionType: 'BUY',
  TradeValue: 100,
  Note: 'DSP ELSS'
};

const rowsAfter2 = [...baseRows, fareedaBuy, ammiBuy];
const ammiAfter2 = computeBalance(rowsAfter2, 'Liquid Mutual Funds', 'Ammi Groww');
console.log('\n--- Test 2: Ammi Groww BUY ₹100 ---');
console.log('Ammi Groww Result:      ₹' + ammiAfter2, ammiAfter2 === 198015 ? '✅ MATCH (Expected: ₹198,015)' : '❌ FAIL');
