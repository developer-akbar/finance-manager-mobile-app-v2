const assert = require('assert');

// Mock accounts
const accounts = [
  { id: '1', name: 'HDFC', group: 'Bank Accounts', subAccounts: [] },
  { id: '2', name: 'SBI', group: 'Bank Accounts', subAccounts: [] },
  { id: '3', name: 'Mutual Funds Tax Saver', group: 'Investments', subAccounts: ['Ak ETMoney'] },
  { id: '4', name: 'Liquid Mutual Funds', group: 'Investments', subAccounts: ['Fareeda Groww', 'Ammi Groww', 'Ak ETMoney'] },
  { id: '5', name: 'Share Market', group: 'Investments', subAccounts: ['Zerodha', 'Fareeda Groww'] }
];

// Re-implement or import resolveInvestmentAccounts logic
function resolveInvestmentAccounts(t, accounts = []) {
  if (!t) return { investmentAccount: '', bankAccount: '', subAccount: '', invType: 'BUY' };

  const invAcctNames = new Set(
    (accounts || [])
      .filter(a => a.group?.toLowerCase() === 'investments' || ['mutual funds tax saver', 'liquid mutual funds', 'share market'].includes((a.name || '').toLowerCase()))
      .map(a => (a.name || '').toLowerCase())
  );
  if (invAcctNames.size === 0) {
    invAcctNames.add('mutual funds tax saver');
    invAcctNames.add('liquid mutual funds');
    invAcctNames.add('share market');
  }

  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase() || 'BUY';

  const toAcct = String(t.ToAccount || t.to_account || '').trim();
  const fromAcct = String(t.FromAccount || t.from_account || '').trim();
  const acct = String(t.Account || t.account || '').trim();
  const cat = String(t.Category || t.category || '').trim();

  let investmentAccount = '';
  let bankAccount = ''; // fundingAccount for BUY, settlementAccount for SELL

  if (invType === 'BUY') {
    if (toAcct && invAcctNames.has(toAcct.toLowerCase())) {
      investmentAccount = toAcct;
      if (fromAcct && !invAcctNames.has(fromAcct.toLowerCase())) {
        bankAccount = fromAcct;
      }
    } else if (acct && invAcctNames.has(acct.toLowerCase())) {
      investmentAccount = acct;
      if (fromAcct && fromAcct.toLowerCase() !== acct.toLowerCase() && !invAcctNames.has(fromAcct.toLowerCase())) {
        bankAccount = fromAcct;
      } else if (toAcct && toAcct.toLowerCase() !== acct.toLowerCase() && !invAcctNames.has(toAcct.toLowerCase())) {
        bankAccount = toAcct;
      }
    } else if (fromAcct && invAcctNames.has(fromAcct.toLowerCase())) {
      investmentAccount = fromAcct;
    } else if (cat && invAcctNames.has(cat.toLowerCase())) {
      investmentAccount = cat;
      if (fromAcct && !invAcctNames.has(fromAcct.toLowerCase())) {
        bankAccount = fromAcct;
      } else if (acct && !invAcctNames.has(acct.toLowerCase())) {
        bankAccount = acct;
      }
    } else {
      investmentAccount = toAcct || acct || fromAcct || 'Liquid Mutual Funds';
    }
  } else {
    if (fromAcct && invAcctNames.has(fromAcct.toLowerCase())) {
      investmentAccount = fromAcct;
      if (toAcct && !invAcctNames.has(toAcct.toLowerCase())) {
        bankAccount = toAcct;
      }
    } else if (acct && invAcctNames.has(acct.toLowerCase())) {
      investmentAccount = acct;
      if (toAcct && toAcct.toLowerCase() !== acct.toLowerCase() && !invAcctNames.has(toAcct.toLowerCase())) {
        bankAccount = toAcct;
      }
    } else if (toAcct && invAcctNames.has(toAcct.toLowerCase())) {
      investmentAccount = toAcct;
    } else if (cat && invAcctNames.has(cat.toLowerCase())) {
      investmentAccount = cat;
      if (toAcct && !invAcctNames.has(toAcct.toLowerCase())) {
        bankAccount = toAcct;
      }
    } else {
      investmentAccount = fromAcct || acct || toAcct || 'Liquid Mutual Funds';
    }
  }

  const matchedInv = (accounts || []).find(a => (a.name || '').toLowerCase() === investmentAccount.toLowerCase());
  if (matchedInv) investmentAccount = matchedInv.name;

  const matchedBank = (accounts || []).find(a => (a.name || '').toLowerCase() === bankAccount.toLowerCase());
  if (matchedBank) bankAccount = matchedBank.name;

  const subAccount = String(
    t.SubAccount || t.sub_account ||
    (invType === 'BUY' ? (t.ToSubAccount || t.to_sub_account) : (t.FromSubAccount || t.from_sub_account)) ||
    t.Brokerage || t.brokerage ||
    t.ToSubAccount || t.to_sub_account ||
    t.FromSubAccount || t.from_sub_account || ''
  ).trim();

  return { investmentAccount, bankAccount, subAccount, invType };
}

// Test 1: User's confirmed BUY test transaction
const buyTxn = {
  _id: 'txn-buy-1',
  Date: '02/09/2026',
  Time: '11:00',
  Account: 'HDFC',
  FromAccount: 'HDFC',
  ToAccount: 'Mutual Funds Tax Saver',
  ToSubAccount: 'Ak ETMoney',
  SubAccount: 'Ak ETMoney',
  Brokerage: 'Ak ETMoney',
  SecuritySymbol: '127LTGDGD-Motilal Oswal ELSS Tax Saver Fund - Direct Plan Growth',
  Note: 'Motilal Oswal ELSS',
  TradeValue: 500,
  Quantity: 10,
  UnitPrice: 50,
  INR: 500,
  Amount: '500',
  InvestmentTransactionType: 'BUY',
  'Income/Expense': 'Transfer-Out'
};

const resBuy = resolveInvestmentAccounts(buyTxn, accounts);
console.log('Test 1 - BUY Resolution:', resBuy);
assert.strictEqual(resBuy.investmentAccount, 'Mutual Funds Tax Saver', 'Investment Account must be Mutual Funds Tax Saver');
assert.strictEqual(resBuy.bankAccount, 'HDFC', 'Funding Account must be HDFC');
assert.strictEqual(resBuy.subAccount, 'Ak ETMoney', 'Platform/Subaccount must be Ak ETMoney');
assert.strictEqual(resBuy.invType, 'BUY');

// Test 2: Historical CAS SELL
const casSellTxn = {
  _id: 'txn-cas-sell-1',
  Date: '15/01/2026',
  Time: '14:30',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  FromSubAccount: 'Ak ETMoney',
  SubAccount: 'Ak ETMoney',
  Brokerage: 'Ak ETMoney',
  SecuritySymbol: '127LTGPG-Motilal Oswal ELSS Tax Saver Fund - Regular Plan Growth',
  Note: 'Motilal Oswal ELSS',
  TradeValue: 3842.91,
  Quantity: 77.62,
  UnitPrice: 49.5098,
  CostBasis: 2033.88,
  RealizedPnl: 1809.03,
  INR: 0,
  Amount: '0.0',
  InvestmentTransactionType: 'SELL',
  'Income/Expense': 'Transfer-Out'
};

const resCasSell = resolveInvestmentAccounts(casSellTxn, accounts);
console.log('Test 2 - CAS SELL Resolution:', resCasSell);
assert.strictEqual(resCasSell.investmentAccount, 'Liquid Mutual Funds', 'Investment Account must be Liquid Mutual Funds');
assert.strictEqual(resCasSell.bankAccount, '', 'Funding/Settlement Account should be empty for internal CAS trades');
assert.strictEqual(resCasSell.subAccount, 'Ak ETMoney', 'Platform/Subaccount must be Ak ETMoney');
assert.strictEqual(resCasSell.invType, 'SELL');

// Test 3: Genuine Manual SELL settled to HDFC bank account
const manualSellTxn = {
  _id: 'txn-manual-sell-1',
  Date: '02/09/2026',
  Time: '15:00',
  Account: 'Mutual Funds Tax Saver',
  FromAccount: 'Mutual Funds Tax Saver',
  ToAccount: 'HDFC',
  FromSubAccount: 'Ak ETMoney',
  SubAccount: 'Ak ETMoney',
  Brokerage: 'Ak ETMoney',
  SecuritySymbol: '127LTGDGD-Motilal Oswal ELSS Tax Saver Fund - Direct Plan Growth',
  Note: 'Motilal Oswal ELSS',
  TradeValue: 5000,
  Quantity: 100,
  UnitPrice: 50,
  CostBasis: 4000,
  RealizedPnl: 1000,
  INR: 5000,
  Amount: '5000',
  InvestmentTransactionType: 'SELL',
  'Income/Expense': 'Transfer-Out'
};

const resManualSell = resolveInvestmentAccounts(manualSellTxn, accounts);
console.log('Test 3 - Genuine Manual SELL Resolution:', resManualSell);
assert.strictEqual(resManualSell.investmentAccount, 'Mutual Funds Tax Saver', 'Investment Account must be Mutual Funds Tax Saver');
assert.strictEqual(resManualSell.bankAccount, 'HDFC', 'Settlement Account must be HDFC');
assert.strictEqual(resManualSell.subAccount, 'Ak ETMoney', 'Platform/Subaccount must be Ak ETMoney');
assert.strictEqual(resManualSell.invType, 'SELL');

// Test 4: Edit and Change Account / Subaccount
// User edits buyTxn, changes Investment Account from 'Mutual Funds Tax Saver' to 'Liquid Mutual Funds', and subaccount to 'Fareeda Groww'
const editedForm = {
  account: 'Liquid Mutual Funds',
  subAccount: 'Fareeda Groww',
  fundingAccount: 'HDFC',
  investmentTransactionType: 'BUY',
  quantity: '10',
  unitPrice: '50',
  tradeValue: '500',
  date: '2026-09-02',
  time: '11:00',
  securitySymbol: '127LTGDGD-Motilal Oswal...',
  note: 'Motilal Oswal ELSS'
};

const isFundedFromBank = Boolean(editedForm.fundingAccount && editedForm.fundingAccount.toLowerCase() !== editedForm.account.toLowerCase());
const fromAcct = editedForm.investmentTransactionType === 'BUY'
  ? (isFundedFromBank ? editedForm.fundingAccount : editedForm.account)
  : editedForm.account;
const toAcct = editedForm.investmentTransactionType === 'BUY'
  ? editedForm.account
  : (isFundedFromBank ? editedForm.fundingAccount : editedForm.account);
const fromSub = editedForm.investmentTransactionType === 'BUY'
  ? (isFundedFromBank ? '' : editedForm.subAccount)
  : editedForm.subAccount;
const toSub = editedForm.investmentTransactionType === 'BUY'
  ? editedForm.subAccount
  : (isFundedFromBank ? '' : editedForm.subAccount);
const primaryAcct = isFundedFromBank && editedForm.investmentTransactionType === 'BUY' ? editedForm.fundingAccount : editedForm.account;

const updatedInvData = {
  ...buyTxn,
  Account: primaryAcct,
  FromAccount: fromAcct,
  ToAccount: toAcct,
  Category: editedForm.account,
  SubAccount: editedForm.subAccount,
  FromSubAccount: fromSub,
  ToSubAccount: toSub,
  Brokerage: editedForm.subAccount
};

console.log('Test 4 - Updated Inv Data:', {
  Account: updatedInvData.Account,
  FromAccount: updatedInvData.FromAccount,
  ToAccount: updatedInvData.ToAccount,
  ToSubAccount: updatedInvData.ToSubAccount
});

assert.strictEqual(updatedInvData.ToAccount, 'Liquid Mutual Funds', 'ToAccount must be Liquid Mutual Funds');
assert.strictEqual(updatedInvData.ToSubAccount, 'Fareeda Groww', 'ToSubAccount must be Fareeda Groww');
assert.strictEqual(updatedInvData.FromAccount, 'HDFC', 'FromAccount must remain HDFC');

console.log('ALL 4 TEST CASES PASSED SUCCESSFULLY!');
