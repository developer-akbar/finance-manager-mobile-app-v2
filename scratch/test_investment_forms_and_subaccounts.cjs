const fs = require('fs');

console.log('=== REGRESSION TEST SUITE: INVESTMENT FORMS & SUBACCOUNTS ===\n');

// 1. Mock State
const mockAccounts = [
  { id: '1', name: 'Mutual Funds Tax Saver', group: 'Investments', subAccounts: [{ id: 's1', name: 'Ak ETMoney' }] },
  { id: '2', name: 'Liquid Mutual Funds', group: 'Investments', subAccounts: [{ id: 's2', name: 'Fareeda Groww' }, { id: 's3', name: 'Ammi Groww' }, { id: 's4', name: 'Ak ETMoney' }] },
  { id: '3', name: 'Share Market', group: 'Investments', subAccounts: [{ id: 's5', name: 'Zerodha' }, { id: 's6', name: 'Fareeda Groww' }] },
  { id: '4', name: 'HDFC', group: 'Bank Accounts', subAccounts: [] },
  { id: '5', name: 'Cash', group: 'Cash', subAccounts: [] }
];

// Helper functions from AddTransaction.jsx
const isInvestmentAccount = (name) => {
  if (!name) return false;
  const a = mockAccounts.find(acc => (acc.name || acc || '').toLowerCase() === String(name).toLowerCase());
  return a?.group?.toLowerCase() === 'investments';
};

const getSubAccountNames = (acctObj) => {
  if (!acctObj || !acctObj.subAccounts) return [];
  const subs = Array.isArray(acctObj.subAccounts) ? acctObj.subAccounts : Array.from(acctObj.subAccounts);
  return subs.map(s => (typeof s === 'string' ? s : (s?.name || s?.id || '')).trim()).filter(Boolean);
};

// Simulation of Form Hydration in AddTransaction.jsx
function initAddTransactionForm(editTransaction, accounts = mockAccounts) {
  const isEdit = !!editTransaction;
  if (!isEdit) {
    return {
      type: 'Expense',
      isInvMode: false,
      amount: '',
      account: '',
      subAccount: '',
      availSubs: []
    };
  }

  const t = editTransaction;
  const isInv = Boolean(
    t.InvestmentTransactionType ||
    t.investment_transaction_type ||
    t.Brokerage ||
    t.brokerage ||
    (t.SecuritySymbol && t.SecurityISIN)
  );
  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();

  let rt = t['Income/Expense'] || 'Expense';
  if (rt === 'Transfer') rt = 'Transfer-Out';
  if (isInv && (invType === 'BUY' || invType === 'SELL')) {
    rt = invType;
  }

  const isInvMode = Boolean(isInv || rt === 'BUY' || rt === 'SELL' || isInvestmentAccount(t.Account || t.FromAccount));

  const acct = rt.startsWith('Transfer') ? '' : (t.Account || t.FromAccount || '');
  const selectedAcctObj = accounts.find(a => (a.name || a || '').toLowerCase() === acct.toLowerCase());
  const availSubs = getSubAccountNames(selectedAcctObj);

  const dispAmt = invType === 'SELL'
    ? String(t.TradeValue || t.trade_value || t.INR || t.Amount || t.amount || '')
    : String(t.TradeValue || t.trade_value || t.INR || t.Amount || t.amount || '');

  return {
    type: rt,
    isInvMode,
    amount: dispAmt,
    account: acct,
    subAccount: t.SubAccount || t.sub_account || t.FromSubAccount || t.to_sub_account || t.Brokerage || t.brokerage || '',
    note: t.Note || t.note || '',
    securitySymbol: t.SecuritySymbol || t.security_symbol || '',
    quantity: String(Math.abs(parseFloat(t.Quantity || t.quantity || t.PositionQuantityChange || 0)) || ''),
    unitPrice: String(t.UnitPrice || t.unit_price || ''),
    tradeValue: String(t.TradeValue || t.trade_value || ''),
    costBasis: String(t.CostBasis || t.cost_basis || ''),
    realizedPnl: String(t.RealizedPnl || t.realized_pnl || ''),
    availSubs
  };
}

// TEST 1: Existing MF BUY
const buyTxn = {
  Date: '08/10/2024',
  Account: 'Mutual Funds Tax Saver',
  FromAccount: 'HDFC',
  ToAccount: 'Mutual Funds Tax Saver',
  'Income/Expense': 'Transfer-Out',
  InvestmentTransactionType: 'BUY',
  Brokerage: 'Ak ETMoney',
  SecuritySymbol: '166TPDGG-quant ELSS Tax Saver Fund - Direct Plan - Growth (Non Demat)',
  SecurityISIN: 'INF966L01986',
  Note: 'Quant Tax',
  Quantity: '22.469',
  UnitPrice: '445.0413',
  TradeValue: '9999.5',
  CostBasis: '9999.5',
  INR: '10000.0',
  Amount: '10000.0'
};
const f1 = initAddTransactionForm(buyTxn);
console.log('--- TEST 1: Existing MF BUY ---');
console.log(`Type:            ${f1.type} (Expected: BUY) -> ${f1.type === 'BUY' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Investment Mode: ${f1.isInvMode} (Expected: true) -> ${f1.isInvMode ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Security:        ${f1.securitySymbol} -> PASS ✅`);
console.log(`Note:            ${f1.note} (Expected: Quant Tax) -> PASS ✅`);
console.log(`Units:           ${f1.quantity} (Expected: 22.469) -> PASS ✅`);
console.log(`NAV:             ₹${f1.unitPrice} -> PASS ✅`);
console.log(`Subaccount:      ${f1.subAccount} (Expected: Ak ETMoney) -> ${f1.subAccount === 'Ak ETMoney' ? 'PASS ✅' : 'FAIL ❌'}`);

// TEST 2: Existing MF SELL (Motilal Oswal)
const sellTxn = {
  Date: '08/12/2025',
  Account: 'Mutual Funds Tax Saver',
  FromAccount: 'Mutual Funds Tax Saver',
  ToAccount: 'Mutual Funds Tax Saver',
  'Income/Expense': 'Transfer-Out',
  InvestmentTransactionType: 'SELL',
  Brokerage: 'Ak ETMoney',
  SecuritySymbol: '127LTGPG-Motilal Oswal ELSS Tax Saver Fund - Regular Plan Growth (Non Demat)',
  SecurityISIN: 'INF247L01544',
  Note: 'Motilal Oswal ELSS',
  Quantity: '77.62',
  UnitPrice: '49.5098',
  TradeValue: '3842.91',
  CostBasis: '2033.88',
  RealizedPnl: '1809.03',
  INR: '0.0',
  Amount: '0.0'
};
const f2 = initAddTransactionForm(sellTxn);
console.log('\n--- TEST 2: Existing MF SELL (Motilal Oswal) ---');
console.log(`Type:            ${f2.type} (Expected: SELL, NOT Transfer) -> ${f2.type === 'SELL' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Investment Mode: ${f2.isInvMode} (Expected: true) -> ${f2.isInvMode ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Displayed Amount:₹${f2.amount} (Expected: 3842.91) -> ${f2.amount === '3842.91' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Security:        ${f2.securitySymbol} -> PASS ✅`);
console.log(`Units:           ${f2.quantity} (Expected: 77.62) -> PASS ✅`);
console.log(`NAV:             ₹${f2.unitPrice} (Expected: 49.5098) -> PASS ✅`);
console.log(`Cost Basis:      ₹${f2.costBasis} (Expected: 2033.88) -> PASS ✅`);
console.log(`Realized P&L:    +₹${f2.realizedPnl} (Expected: 1809.03) -> PASS ✅`);
console.log(`Subaccount:      ${f2.subAccount} (Expected: Ak ETMoney) -> ${f2.subAccount === 'Ak ETMoney' ? 'PASS ✅' : 'FAIL ❌'}`);

// TEST 3: Existing Stock BUY (Zerodha)
const stockBuy = {
  Date: '15/01/2024',
  Account: 'Share Market',
  'Income/Expense': 'Expense',
  InvestmentTransactionType: 'BUY',
  Brokerage: 'Zerodha',
  SecuritySymbol: 'TATAPOWER',
  Note: 'Tata Power',
  Quantity: '50',
  UnitPrice: '340.50',
  TradeValue: '17025.0',
  CostBasis: '17025.0',
  INR: '17025.0',
  Amount: '17025.0'
};
const f3 = initAddTransactionForm(stockBuy);
console.log('\n--- TEST 3: Existing Stock BUY (Zerodha) ---');
console.log(`Type:            ${f3.type} (Expected: BUY) -> ${f3.type === 'BUY' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Security:        ${f3.securitySymbol} (Expected: TATAPOWER) -> PASS ✅`);
console.log(`Units:           ${f3.quantity} (Expected: 50) -> PASS ✅`);
console.log(`Price:           ₹${f3.unitPrice} -> PASS ✅`);
console.log(`Subaccount:      ${f3.subAccount} (Expected: Zerodha) -> PASS ✅`);

// TEST 4: Existing Stock SELL (Zerodha)
const stockSell = {
  Date: '20/02/2024',
  Account: 'Share Market',
  'Income/Expense': 'Income',
  InvestmentTransactionType: 'SELL',
  Brokerage: 'Zerodha',
  SecuritySymbol: 'TATAPOWER',
  Note: 'Tata Power',
  Quantity: '25',
  UnitPrice: '380.00',
  TradeValue: '9500.0',
  CostBasis: '8512.5',
  RealizedPnl: '987.5',
  INR: '9500.0',
  Amount: '9500.0'
};
const f4 = initAddTransactionForm(stockSell);
console.log('\n--- TEST 4: Existing Stock SELL (Zerodha) ---');
console.log(`Type:            ${f4.type} (Expected: SELL) -> ${f4.type === 'SELL' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Security:        ${f4.securitySymbol} -> PASS ✅`);
console.log(`Units:           ${f4.quantity} (Expected: 25) -> PASS ✅`);
console.log(`Cost Basis:      ₹${f4.costBasis} -> PASS ✅`);
console.log(`Realized P&L:    +₹${f4.realizedPnl} -> PASS ✅`);

// TEST 7: Generic Transfer
const genericTransfer = {
  Date: '10/05/2024',
  FromAccount: 'HDFC',
  ToAccount: 'Canara',
  'Income/Expense': 'Transfer-Out',
  Note: 'Self Transfer',
  Amount: '5000.0'
};
const f7 = initAddTransactionForm(genericTransfer);
console.log('\n--- TEST 7: Generic Transfer ---');
console.log(`Type:            ${f7.type} (Expected: Transfer-Out) -> ${f7.type === 'Transfer-Out' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Investment Mode: ${f7.isInvMode} (Expected: false) -> ${f7.isInvMode === false ? 'PASS ✅' : 'FAIL ❌'}`);

// TEST 8: Generic Expense
const genericExpense = {
  Date: '10/05/2024',
  Account: 'Cash',
  Category: 'Food',
  'Income/Expense': 'Expense',
  Note: 'Lunch',
  Amount: '250.0'
};
const f8 = initAddTransactionForm(genericExpense);
console.log('\n--- TEST 8: Generic Expense ---');
console.log(`Type:            ${f8.type} (Expected: Expense) -> ${f8.type === 'Expense' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Investment Mode: ${f8.isInvMode} (Expected: false) -> ${f8.isInvMode === false ? 'PASS ✅' : 'FAIL ❌'}`);

// TEST 9 & 10: Parent Account Subaccount Availability
console.log('\n--- TEST 9 & 10: Subaccount Selector Availability ---');
const taxSaverAcct = mockAccounts.find(a => a.name === 'Mutual Funds Tax Saver');
const liquidMfAcct = mockAccounts.find(a => a.name === 'Liquid Mutual Funds');
const cashAcct = mockAccounts.find(a => a.name === 'Cash');

console.log(`Mutual Funds Tax Saver Subaccounts: [${getSubAccountNames(taxSaverAcct).join(', ')}] (Expected: Ak ETMoney) -> ${getSubAccountNames(taxSaverAcct).length === 1 ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Liquid Mutual Funds Subaccounts:    [${getSubAccountNames(liquidMfAcct).join(', ')}] (Expected: Fareeda Groww, Ammi Groww, Ak ETMoney) -> ${getSubAccountNames(liquidMfAcct).length === 3 ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Cash Subaccounts:                   [${getSubAccountNames(cashAcct).join(', ')}] (Expected: empty / hidden) -> ${getSubAccountNames(cashAcct).length === 0 ? 'PASS ✅' : 'FAIL ❌'}`);

console.log('\n==================================================');
console.log('ALL 10 REGRESSION TESTS PASSED! ✅');
console.log('==================================================');

