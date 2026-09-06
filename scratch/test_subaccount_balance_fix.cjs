const assert = require('assert');

// 1. Define resolveInvestmentSubAccount logic
function parseTxnFields(t) {
  if (!t) return null;
  const desc = String(t.Description || t.description || '').trim();
  const type = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim();
  let broker = String(t.Brokerage || t.brokerage || t.SubAccount || t.sub_account || '').trim();
  if (desc.includes('|')) {
    const parts = desc.split('|').map(p => p.trim());
    parts.forEach(p => {
      const m = p.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
      if (m && (m[1] === 'Broker' || m[1] === 'Brokerage')) broker = m[2].trim();
    });
  }
  return { brokerage: broker, type };
}

function resolveInvestmentParent(txn) {
  if (!txn) return null;
  const acct = String(txn.Account || txn.account || '').trim();
  const fromAcct = String(txn.FromAccount || txn.from_account || '').trim();
  const toAcct = String(txn.ToAccount || txn.to_account || '').trim();
  const cat = String(txn.Category || txn.category || '').trim();
  const invAcct = String(txn.InvestmentAccount || txn.investment_account || '').trim();

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

function resolveInvestmentSubAccount(t, parentAsset) {
  if (!t) return null;
  const parent = parentAsset || resolveInvestmentParent(t);

  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
  const sub = String(
    t.SubAccount || t.sub_account ||
    (invType === 'BUY' ? (t.ToSubAccount || t.to_sub_account) : (t.FromSubAccount || t.from_sub_account)) ||
    t.Brokerage || t.brokerage ||
    t.ToSubAccount || t.to_sub_account ||
    t.FromSubAccount || t.from_sub_account || ''
  ).trim();
  if (sub && sub !== 'Default') return sub;

  const f = parseTxnFields(t);
  const broker = String(f?.brokerage || '').trim();
  if (broker && broker !== 'Default') return broker;

  const src = String(t.Source || t.source || '').trim();
  if (src.includes('CAS') || src.includes('CAMS')) {
    return 'Ak ETMoney';
  }

  const note = String(t.Note || t.note || '').toLowerCase();
  const desc = String(t.Description || t.description || '').toLowerCase();
  const combined = `${note} ${desc}`;

  const parentLower = String(parent || '').toLowerCase();

  if (parentLower.includes('share market') || parentLower === 'share market') {
    if (combined.includes('groww') || combined.includes('fareeda')) return 'Fareeda Groww';
    return 'Zerodha';
  }

  if (parentLower.includes('tax saver') || parentLower === 'mutual funds tax saver') {
    return 'Ak ETMoney';
  }

  if (parentLower.includes('liquid') || parentLower === 'liquid mutual funds') {
    if (combined.includes('ammi grow') || combined.includes('ammi')) return 'Ammi Groww';
    if (combined.includes('fareeda') && combined.includes('groww')) return 'Fareeda Groww';
    if (combined.includes('fareeda') && combined.includes('etmoney')) return 'Fareeda ETMoney';
    if (combined.includes('scripbox')) return 'Scripbox';
    if (combined.includes('groww')) return 'Fareeda Groww';
    if (t.InvestmentTransactionType || t.SecurityISIN) return 'Ak ETMoney';
    return 'Fareeda Groww';
  }

  return null;
}

function buildBalanceMap(transactions) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
  const ensure = n => { if (n && !looksNumeric(n) && !map[n]) map[n] = 0; };
  const addTo = (n, v) => { if (n && !looksNumeric(n)) { ensure(n); map[n] = (map[n] || 0) + v; } };

  for (const t of transactions) {
    const amt = parseFloat(t.INR || t.Amount || 0);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();

    if (type === 'Income') {
      addTo(dest || acct, +amt);
    } else if (type === 'Expense') {
      addTo(fromAcct || acct, -amt);
    } else if (type === 'Transfer-Out') {
      addTo(fromAcct, -amt);
      addTo(dest, +amt);
    }
  }
  return map;
}

function buildSubAccountBalanceMap(transactions) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());

  for (const t of transactions) {
    const amt = parseFloat(t.INR || t.Amount || 0);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();

    const sub = String(t.SubAccount || t.sub_account || '').trim();
    const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
    const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

    const isFromInv = fromAcct === 'Mutual Funds Tax Saver' || fromAcct === 'Liquid Mutual Funds' || fromAcct === 'Share Market';
    const isDestInv = dest === 'Mutual Funds Tax Saver' || dest === 'Liquid Mutual Funds' || dest === 'Share Market';
    const isAcctInv = acct === 'Mutual Funds Tax Saver' || acct === 'Liquid Mutual Funds' || acct === 'Share Market';

    const resolvedFromSub = (fromSub && fromSub !== 'Default') ? fromSub : (isFromInv ? resolveInvestmentSubAccount(t, fromAcct) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedToSub = (toSub && toSub !== 'Default') ? toSub : (isDestInv ? resolveInvestmentSubAccount(t, dest) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedAcctSub = (sub && sub !== 'Default') ? sub : (isAcctInv ? resolveInvestmentSubAccount(t, acct) : '');

    if (type === 'Income') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
        if (!map[targetAcct]) map[targetAcct] = {};
        map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) + amt;
      }
    } else if (type === 'Expense') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
        if (!map[targetAcct]) map[targetAcct] = {};
        map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) - amt;
      }
    } else if (type === 'Transfer-Out') {
      if (fromAcct && resolvedFromSub && !looksNumeric(fromAcct)) {
        if (!map[fromAcct]) map[fromAcct] = {};
        map[fromAcct][resolvedFromSub] = (map[fromAcct][resolvedFromSub] || 0) - amt;
      }
      if (dest && resolvedToSub && !looksNumeric(dest)) {
        if (!map[dest]) map[dest] = {};
        map[dest][resolvedToSub] = (map[dest][resolvedToSub] || 0) + amt;
      }
    }
  }
  return map;
}

console.log('=== TEST SUITE: SUBACCOUNT BALANCE RESOLUTION ===\n');

// 1. Initial State:
// Legacy BUY transactions into Mutual Funds Tax Saver totaling 204,000 (SubAccount empty, as in real legacy data)
let txns = [
  { ID: 'legacy_1', 'Income/Expense': 'Transfer-Out', FromAccount: 'HDFC', ToAccount: 'Mutual Funds Tax Saver', Amount: '100000', INR: '100000', Note: 'DSP Tax Saver' },
  { ID: 'legacy_2', 'Income/Expense': 'Transfer-Out', FromAccount: 'HDFC', ToAccount: 'Mutual Funds Tax Saver', Amount: '104000', INR: '104000', Note: 'Motilal Oswal ELSS' },
];

let pBals = buildBalanceMap(txns);
let sBals = buildSubAccountBalanceMap(txns);

console.log('1. Initial State (Before SELL):');
console.log('   Parent Mutual Funds Tax Saver balance:', pBals['Mutual Funds Tax Saver']);
console.log('   Subaccount Ak ETMoney balance:', sBals['Mutual Funds Tax Saver']['Ak ETMoney']);
assert.strictEqual(pBals['Mutual Funds Tax Saver'], 204000);
assert.strictEqual(sBals['Mutual Funds Tax Saver']['Ak ETMoney'], 204000);

// 2. SELL Transaction:
// Mutual Funds Tax Saver (Ak ETMoney) -> HDFC ₹130
const sellTxn = {
  ID: 'sell_001',
  'Income/Expense': 'Transfer-Out',
  InvestmentTransactionType: 'SELL',
  InvestmentAccount: 'Mutual Funds Tax Saver',
  FromAccount: 'Mutual Funds Tax Saver',
  FromSubAccount: 'Ak ETMoney',
  SubAccount: 'Ak ETMoney',
  ToAccount: 'HDFC',
  Amount: '130',
  INR: '130',
  Note: 'Motilal Oswal ELSS'
};
txns.push(sellTxn);

pBals = buildBalanceMap(txns);
sBals = buildSubAccountBalanceMap(txns);

console.log('\n2. After SELL of ₹130:');
console.log('   Parent Mutual Funds Tax Saver balance:', pBals['Mutual Funds Tax Saver']);
console.log('   Subaccount Ak ETMoney balance:', sBals['Mutual Funds Tax Saver']['Ak ETMoney']);
assert.strictEqual(pBals['Mutual Funds Tax Saver'], 203870);
assert.strictEqual(sBals['Mutual Funds Tax Saver']['Ak ETMoney'], 203870);

// 3. Delete SELL:
txns = txns.filter(t => t.ID !== 'sell_001');

pBals = buildBalanceMap(txns);
sBals = buildSubAccountBalanceMap(txns);

console.log('\n3. After Deleting SELL:');
console.log('   Parent Mutual Funds Tax Saver balance:', pBals['Mutual Funds Tax Saver']);
console.log('   Subaccount Ak ETMoney balance:', sBals['Mutual Funds Tax Saver']['Ak ETMoney']);
assert.strictEqual(pBals['Mutual Funds Tax Saver'], 204000);
assert.strictEqual(sBals['Mutual Funds Tax Saver']['Ak ETMoney'], 204000);

// 4. Liquid Mutual Funds Tests:
// BUY ₹10,000 into Fareeda Groww
// BUY ₹5,000 into Ammi Groww
// BUY ₹2,000 into Ak ETMoney
txns.push({
  ID: 'lmf_1',
  'Income/Expense': 'Transfer-Out',
  InvestmentTransactionType: 'BUY',
  InvestmentAccount: 'Liquid Mutual Funds',
  FromAccount: 'HDFC',
  ToAccount: 'Liquid Mutual Funds',
  ToSubAccount: 'Fareeda Groww',
  SubAccount: 'Fareeda Groww',
  Amount: '10000',
  INR: '10000'
});

txns.push({
  ID: 'lmf_2',
  'Income/Expense': 'Transfer-Out',
  InvestmentTransactionType: 'BUY',
  InvestmentAccount: 'Liquid Mutual Funds',
  FromAccount: 'HDFC',
  ToAccount: 'Liquid Mutual Funds',
  ToSubAccount: 'Ammi Groww',
  SubAccount: 'Ammi Groww',
  Amount: '5000',
  INR: '5000'
});

txns.push({
  ID: 'lmf_3',
  'Income/Expense': 'Transfer-Out',
  InvestmentTransactionType: 'BUY',
  InvestmentAccount: 'Liquid Mutual Funds',
  FromAccount: 'HDFC',
  ToAccount: 'Liquid Mutual Funds',
  ToSubAccount: 'Ak ETMoney',
  SubAccount: 'Ak ETMoney',
  Amount: '2000',
  INR: '2000'
});

pBals = buildBalanceMap(txns);
sBals = buildSubAccountBalanceMap(txns);

console.log('\n4. Liquid Mutual Funds Multiple Subaccounts:');
console.log('   Parent Liquid Mutual Funds balance:', pBals['Liquid Mutual Funds']);
console.log('   Fareeda Groww balance:', sBals['Liquid Mutual Funds']['Fareeda Groww']);
console.log('   Ammi Groww balance:', sBals['Liquid Mutual Funds']['Ammi Groww']);
console.log('   Ak ETMoney balance:', sBals['Liquid Mutual Funds']['Ak ETMoney']);
assert.strictEqual(pBals['Liquid Mutual Funds'], 17000);
assert.strictEqual(sBals['Liquid Mutual Funds']['Fareeda Groww'], 10000);
assert.strictEqual(sBals['Liquid Mutual Funds']['Ammi Groww'], 5000);
assert.strictEqual(sBals['Liquid Mutual Funds']['Ak ETMoney'], 2000);
assert.strictEqual(
  sBals['Liquid Mutual Funds']['Fareeda Groww'] + sBals['Liquid Mutual Funds']['Ammi Groww'] + sBals['Liquid Mutual Funds']['Ak ETMoney'],
  pBals['Liquid Mutual Funds']
);

// 5. SELL from Ammi Groww ₹1,000:
txns.push({
  ID: 'lmf_sell_1',
  'Income/Expense': 'Transfer-Out',
  InvestmentTransactionType: 'SELL',
  InvestmentAccount: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  FromSubAccount: 'Ammi Groww',
  SubAccount: 'Ammi Groww',
  ToAccount: 'HDFC',
  Amount: '1000',
  INR: '1000'
});

pBals = buildBalanceMap(txns);
sBals = buildSubAccountBalanceMap(txns);

console.log('\n5. SELL ₹1,000 from Ammi Groww:');
console.log('   Parent Liquid Mutual Funds balance:', pBals['Liquid Mutual Funds']);
console.log('   Ammi Groww balance:', sBals['Liquid Mutual Funds']['Ammi Groww']);
assert.strictEqual(pBals['Liquid Mutual Funds'], 16000);
assert.strictEqual(sBals['Liquid Mutual Funds']['Ammi Groww'], 4000);
assert.strictEqual(sBals['Liquid Mutual Funds']['Fareeda Groww'], 10000);
assert.strictEqual(sBals['Liquid Mutual Funds']['Ak ETMoney'], 2000);

// 6. Switch subaccount on edit:
// Change lmf_1 (₹10,000) from Fareeda Groww to Ak ETMoney
const idx = txns.findIndex(t => t.ID === 'lmf_1');
txns[idx] = {
  ...txns[idx],
  ToSubAccount: 'Ak ETMoney',
  SubAccount: 'Ak ETMoney'
};

pBals = buildBalanceMap(txns);
sBals = buildSubAccountBalanceMap(txns);

console.log('\n6. Switch transaction from Fareeda Groww to Ak ETMoney:');
console.log('   Parent Liquid Mutual Funds balance:', pBals['Liquid Mutual Funds']);
console.log('   Fareeda Groww balance:', sBals['Liquid Mutual Funds']['Fareeda Groww']);
console.log('   Ak ETMoney balance:', sBals['Liquid Mutual Funds']['Ak ETMoney']);
assert.strictEqual(pBals['Liquid Mutual Funds'], 16000);
assert.strictEqual(sBals['Liquid Mutual Funds']['Fareeda Groww'] || 0, 0);
assert.strictEqual(sBals['Liquid Mutual Funds']['Ak ETMoney'], 12000); // 2000 + 10000

console.log('\n========================================');
console.log('ALL SUBACCOUNT TESTS PASSED 100%!');
console.log('========================================\n');
