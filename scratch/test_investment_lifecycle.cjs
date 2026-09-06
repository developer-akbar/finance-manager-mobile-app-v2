const assert = require('assert');

// Mock accounts list as defined in finman-v2
const accounts = [
  { id: '1', name: 'HDFC', group: 'Bank Accounts', subAccounts: [] },
  { id: '2', name: 'SBI', group: 'Bank Accounts', subAccounts: [] },
  { id: '3', name: 'Mutual Funds Tax Saver', group: 'Investments', subAccounts: ['Ak ETMoney'] },
  { id: '4', name: 'Liquid Mutual Funds', group: 'Investments', subAccounts: ['Fareeda Groww', 'Ammi Groww', 'Ak ETMoney'] },
  { id: '5', name: 'Share Market', group: 'Investments', subAccounts: ['Zerodha', 'Fareeda Groww'] }
];

function getSortedSubs(acct) {
  if (!acct || !acct.subAccounts) return [];
  return [...new Set(acct.subAccounts.map(s => String(s).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// Logic from src/utils/brokerageAccounting.js
function resolveInvestmentAccounts(t, accounts = []) {
  if (!t) return { investmentAccount: '', bankAccount: '', subAccount: '', invType: 'BUY' };

  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase() || 'BUY';
  let explicitInvAcct = String(t.InvestmentAccount || t.investment_account || '').trim();

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

  const toAcct = String(t.ToAccount || t.to_account || '').trim();
  const fromAcct = String(t.FromAccount || t.from_account || '').trim();
  const acct = String(t.Account || t.account || '').trim();
  const cat = String(t.Category || t.category || '').trim();

  let investmentAccount = explicitInvAcct;
  let bankAccount = '';

  if (!investmentAccount) {
    if (invType === 'BUY') {
      if (toAcct && invAcctNames.has(toAcct.toLowerCase())) {
        investmentAccount = toAcct;
      } else if (acct && invAcctNames.has(acct.toLowerCase())) {
        investmentAccount = acct;
      } else if (fromAcct && invAcctNames.has(fromAcct.toLowerCase())) {
        investmentAccount = fromAcct;
      } else if (cat && invAcctNames.has(cat.toLowerCase())) {
        investmentAccount = cat;
      } else {
        investmentAccount = toAcct || acct || fromAcct || 'Liquid Mutual Funds';
      }
    } else {
      if (fromAcct && invAcctNames.has(fromAcct.toLowerCase())) {
        investmentAccount = fromAcct;
      } else if (acct && invAcctNames.has(acct.toLowerCase())) {
        investmentAccount = acct;
      } else if (toAcct && invAcctNames.has(toAcct.toLowerCase())) {
        investmentAccount = toAcct;
      } else if (cat && invAcctNames.has(cat.toLowerCase())) {
        investmentAccount = cat;
      } else {
        investmentAccount = fromAcct || acct || toAcct || 'Liquid Mutual Funds';
      }
    }
  }

  if (invType === 'BUY') {
    if (fromAcct && fromAcct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(fromAcct.toLowerCase())) {
      bankAccount = fromAcct;
    } else if (acct && acct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(acct.toLowerCase())) {
      bankAccount = acct;
    }
  } else {
    if (toAcct && toAcct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(toAcct.toLowerCase())) {
      bankAccount = toAcct;
    } else if (acct && acct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(acct.toLowerCase())) {
      bankAccount = acct;
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

// Simulated mock database
class MockDB {
  constructor() {
    this.investment_transactions = new Map();
    this.transactions = new Map();
  }

  addTransaction(data) {
    const id = data.ID || data._id || 'id_' + Math.random();
    const isInv = !!(data.InvestmentTransactionType || data.Brokerage);
    const row = { ...data, ID: id, _id: id, id };
    if (isInv) {
      this.investment_transactions.set(id, row);
    } else {
      this.transactions.set(id, row);
    }
    return row;
  }

  updateTransaction(id, data) {
    this.investment_transactions.delete(id);
    this.transactions.delete(id);
    return this.addTransaction({ ...data, ID: id });
  }

  getAllTransactions() {
    return [...this.transactions.values(), ...this.investment_transactions.values()];
  }

  calculateLedgerBalances() {
    const balances = {};
    for (const t of this.getAllTransactions()) {
      const amt = parseFloat(t.INR || t.Amount || 0);
      const type = t['Income/Expense'];
      if (type === 'Transfer-Out') {
        const from = t.FromAccount || t.Account;
        const to = t.ToAccount;
        if (from) balances[from] = (balances[from] || 0) - amt;
        if (to) balances[to] = (balances[to] || 0) + amt;

        const fromSub = t.FromSubAccount;
        const toSub = t.ToSubAccount || t.SubAccount;
        if (fromSub) balances[`${from}:${fromSub}`] = (balances[`${from}:${fromSub}`] || 0) - amt;
        if (toSub && to) balances[`${to}:${toSub}`] = (balances[`${to}:${toSub}`] || 0) + amt;
      }
    }
    return balances;
  }
}

// Simulated save payload generator as implemented in AddTransaction.jsx
function createInvSavePayload(form, isEdit = false, editTransaction = null) {
  const invType = form.type === 'BUY' || form.type === 'SELL' ? form.type : (form.investmentTransactionType || 'BUY');
  const qty = parseFloat(form.quantity) || 0;
  const price = parseFloat(form.unitPrice) || 0;
  const tradeVal = parseFloat(form.tradeValue) || (qty * price) || parseFloat(form.amount) || 0;
  const costBasis = parseFloat(form.costBasis) || 0;
  const realizedPnl = parseFloat(form.realizedPnl) || 0;

  const currentInvAcct = form.investmentAccount || form.account || '';
  const currentSubAcct = form.subAccount || '';
  const fundingBankAcct = (invType === 'BUY' ? form.fundingAccount : (form.settlementAccount || form.fundingAccount)) || '';
  const isFundedFromBank = Boolean(fundingBankAcct && fundingBankAcct.toLowerCase() !== currentInvAcct.toLowerCase());

  const fromAcct = invType === 'BUY'
    ? (isFundedFromBank ? fundingBankAcct : currentInvAcct)
    : currentInvAcct;

  const toAcct = invType === 'BUY'
    ? currentInvAcct
    : (isFundedFromBank ? fundingBankAcct : currentInvAcct);

  const fromSub = invType === 'BUY'
    ? (isFundedFromBank ? '' : currentSubAcct)
    : currentSubAcct;

  const toSub = invType === 'BUY'
    ? currentSubAcct
    : (isFundedFromBank ? '' : currentSubAcct);

  const primaryAcct = isFundedFromBank && invType === 'BUY' ? fundingBankAcct : currentInvAcct;

  const isCasSell = isEdit && invType === 'SELL' && (parseFloat(editTransaction?.INR || 0) === 0 || String(editTransaction?.Amount || '') === '0.0') && !isFundedFromBank;
  const savedInr = isCasSell ? 0 : tradeVal;
  const savedAmount = isCasSell ? (editTransaction?.Amount || '0.0') : String(tradeVal);

  return {
    Date: form.date,
    Time: form.time || '',
    Account: primaryAcct,
    FromAccount: fromAcct,
    ToAccount: toAcct,
    Category: currentInvAcct,
    Subcategory: form.subcategory || 'Default',
    Note: form.note || form.securitySymbol || '',
    Description: form.description || '',
    INR: savedInr,
    Amount: savedAmount,
    Currency: 'INR',
    'Income/Expense': isEdit ? (editTransaction?.['Income/Expense'] || 'Transfer-Out') : 'Transfer-Out',
    Tags: form.tags || '',
    _id: editTransaction?._id,
    ID: editTransaction?.ID || editTransaction?.id || editTransaction?._id,
    InvestmentAccount: currentInvAcct,
    investment_account: currentInvAcct,
    SubAccount: currentSubAcct,
    FromSubAccount: fromSub,
    ToSubAccount: toSub,
    InvestmentTransactionType: invType,
    Brokerage: currentSubAcct,
    SecuritySymbol: form.securitySymbol || '',
    SecurityISIN: form.securityISIN || '',
    Quantity: qty,
    UnitPrice: price,
    TradeValue: tradeVal,
    CostBasis: costBasis,
    RealizedPnl: realizedPnl,
    CashImpact: isCasSell ? 0 : (invType === 'BUY' ? -tradeVal : tradeVal),
    PositionQuantityChange: invType === 'SELL' ? -Math.abs(qty) : Math.abs(qty),
    Source: isEdit ? (editTransaction?.Source || 'Manual') : 'Manual'
  };
}

// Simulated Edit Hydration as implemented in AddTransaction.jsx
function hydrateEditForm(editTransaction, accounts) {
  const t = editTransaction;
  const isInv = Boolean(t.InvestmentTransactionType || t.Brokerage || (t.SecuritySymbol && t.SecurityISIN));
  const invType = String(t.InvestmentTransactionType || '').trim().toUpperCase() || 'BUY';

  let initialInvestmentAccount = '';
  let initialSubAccount = t.SubAccount || t.ToSubAccount || t.Brokerage || '';
  let initialFundingAccount = '';
  let initialSettlementAccount = '';

  if (isInv) {
    const res = resolveInvestmentAccounts(t, accounts);
    initialInvestmentAccount = res.investmentAccount || t.InvestmentAccount || t.Category || '';
    if (res.invType === 'BUY') {
      initialFundingAccount = res.bankAccount;
    } else {
      initialSettlementAccount = res.bankAccount;
    }
    if (res.subAccount) initialSubAccount = res.subAccount;
  }

  return {
    type: 'Investment',
    investmentTransactionType: invType,
    investmentAccount: initialInvestmentAccount,
    account: initialInvestmentAccount,
    subAccount: initialSubAccount,
    fundingAccount: initialFundingAccount,
    settlementAccount: initialSettlementAccount,
    securitySymbol: t.SecuritySymbol || '',
    note: t.Note || '',
    quantity: String(t.Quantity || ''),
    unitPrice: String(t.UnitPrice || ''),
    tradeValue: String(t.TradeValue || ''),
    date: t.Date,
    time: t.Time
  };
}

console.log('=== STARTING COMPLETE REGRESSION TEST SUITE ===');

const db = new MockDB();

// ----------------------------------------------------
// TEST 1: Initial BUY creation (user's verified test case)
// ----------------------------------------------------
console.log('\n--- 1. Initial CREATE BUY ---');
const createForm = {
  type: 'BUY',
  investmentTransactionType: 'BUY',
  investmentAccount: 'Mutual Funds Tax Saver',
  account: 'Mutual Funds Tax Saver',
  subAccount: 'Ak ETMoney',
  fundingAccount: 'HDFC',
  securitySymbol: 'Motilal Oswal ELSS',
  note: 'Motilal Oswal ELSS',
  quantity: '10',
  unitPrice: '50',
  tradeValue: '500',
  date: '2026-09-02',
  time: '11:00'
};

const createPayload = createInvSavePayload(createForm, false);
const createdTxn = db.addTransaction({ ...createPayload, ID: 'txn_001', _id: 'txn_001' });

console.log('Created Txn in DB:', {
  ID: createdTxn.ID,
  InvestmentAccount: createdTxn.InvestmentAccount,
  FromAccount: createdTxn.FromAccount,
  ToAccount: createdTxn.ToAccount,
  ToSubAccount: createdTxn.ToSubAccount
});

assert.strictEqual(createdTxn.InvestmentAccount, 'Mutual Funds Tax Saver');
assert.strictEqual(createdTxn.FromAccount, 'HDFC');
assert.strictEqual(createdTxn.ToAccount, 'Mutual Funds Tax Saver');
assert.strictEqual(createdTxn.ToSubAccount, 'Ak ETMoney');

let balances = db.calculateLedgerBalances();
console.log('Balances after CREATE:', balances);
assert.strictEqual(balances['HDFC'], -500);
assert.strictEqual(balances['Mutual Funds Tax Saver'], 500);
assert.strictEqual(balances['Mutual Funds Tax Saver:Ak ETMoney'], 500);

// ----------------------------------------------------
// TEST 2: Edit and Change:
// Mutual Funds Tax Saver + Ak ETMoney -> Liquid Mutual Funds + Fareeda Groww
// ----------------------------------------------------
console.log('\n--- 2. Edit: Mutual Funds Tax Saver -> Liquid Mutual Funds & Ak ETMoney -> Fareeda Groww ---');

// User opens edit:
const editForm1 = hydrateEditForm(createdTxn, accounts);
console.log('Hydrated Edit Form:', {
  investmentAccount: editForm1.investmentAccount,
  subAccount: editForm1.subAccount,
  fundingAccount: editForm1.fundingAccount
});
assert.strictEqual(editForm1.investmentAccount, 'Mutual Funds Tax Saver');
assert.strictEqual(editForm1.subAccount, 'Ak ETMoney');
assert.strictEqual(editForm1.fundingAccount, 'HDFC');

// User selects new parent: "Liquid Mutual Funds"
editForm1.investmentAccount = 'Liquid Mutual Funds';
editForm1.account = 'Liquid Mutual Funds';

// Available subaccounts for Liquid Mutual Funds:
const parentAcctObj1 = accounts.find(a => a.name.toLowerCase() === editForm1.investmentAccount.toLowerCase());
const availableSubs1 = getSortedSubs(parentAcctObj1);
console.log('Available subs for Liquid Mutual Funds:', availableSubs1);
assert.deepStrictEqual(availableSubs1, ['Ak ETMoney', 'Ammi Groww', 'Fareeda Groww']);

// User selects: "Fareeda Groww"
editForm1.subAccount = 'Fareeda Groww';

// User saves:
const editPayload1 = createInvSavePayload(editForm1, true, createdTxn);
console.log('Edit Save Payload:', {
  InvestmentAccount: editPayload1.InvestmentAccount,
  SubAccount: editPayload1.SubAccount,
  FromAccount: editPayload1.FromAccount,
  ToAccount: editPayload1.ToAccount,
  ToSubAccount: editPayload1.ToSubAccount
});

assert.strictEqual(editPayload1.InvestmentAccount, 'Liquid Mutual Funds', 'Payload InvestmentAccount must be Liquid Mutual Funds');
assert.strictEqual(editPayload1.SubAccount, 'Fareeda Groww', 'Payload SubAccount must be Fareeda Groww');
assert.strictEqual(editPayload1.ToAccount, 'Liquid Mutual Funds', 'Payload ToAccount must be Liquid Mutual Funds');
assert.strictEqual(editPayload1.ToSubAccount, 'Fareeda Groww', 'Payload ToSubAccount must be Fareeda Groww');
assert.strictEqual(editPayload1.FromAccount, 'HDFC', 'Payload FromAccount must be HDFC');

// Save to DB (updateTransaction replaces old record atomically)
const updatedTxn1 = db.updateTransaction(createdTxn.ID, editPayload1);

// Verify actual DB content
const persistedRecord1 = db.investment_transactions.get(createdTxn.ID);
console.log('Persisted Record in DB:', {
  ID: persistedRecord1.ID,
  InvestmentAccount: persistedRecord1.InvestmentAccount,
  SubAccount: persistedRecord1.SubAccount,
  ToAccount: persistedRecord1.ToAccount,
  ToSubAccount: persistedRecord1.ToSubAccount,
  FromAccount: persistedRecord1.FromAccount
});
assert.strictEqual(persistedRecord1.InvestmentAccount, 'Liquid Mutual Funds');
assert.strictEqual(persistedRecord1.SubAccount, 'Fareeda Groww');
assert.strictEqual(persistedRecord1.ToAccount, 'Liquid Mutual Funds');
assert.strictEqual(persistedRecord1.ToSubAccount, 'Fareeda Groww');
assert.strictEqual(persistedRecord1.FromAccount, 'HDFC');

// Verify accounting movement
balances = db.calculateLedgerBalances();
console.log('Balances after Edit:', balances);
assert.strictEqual(balances['HDFC'], -500, 'HDFC balance must be -500');
assert.strictEqual(balances['Liquid Mutual Funds'], 500, 'Liquid Mutual Funds must be +500');
assert.strictEqual(balances['Liquid Mutual Funds:Fareeda Groww'], 500, 'Fareeda Groww must be +500');
assert.strictEqual(balances['Mutual Funds Tax Saver'] || 0, 0, 'Mutual Funds Tax Saver must be restored to 0');
assert.strictEqual(balances['Mutual Funds Tax Saver:Ak ETMoney'] || 0, 0, 'Ak ETMoney under MF Tax Saver must be restored to 0');

// Verify View / Reopen Edit Hydration
const reopenForm1 = hydrateEditForm(persistedRecord1, accounts);
console.log('Reopen Hydrated Form:', {
  investmentAccount: reopenForm1.investmentAccount,
  subAccount: reopenForm1.subAccount,
  fundingAccount: reopenForm1.fundingAccount
});
assert.strictEqual(reopenForm1.investmentAccount, 'Liquid Mutual Funds', 'Reopen must show Liquid Mutual Funds');
assert.strictEqual(reopenForm1.subAccount, 'Fareeda Groww', 'Reopen must show Fareeda Groww');
assert.strictEqual(reopenForm1.fundingAccount, 'HDFC', 'Reopen must show HDFC');

// ----------------------------------------------------
// TEST 3: Reverse Edit:
// Liquid Mutual Funds + Fareeda Groww -> Mutual Funds Tax Saver + Ak ETMoney
// ----------------------------------------------------
console.log('\n--- 3. Reverse Edit: Liquid Mutual Funds -> Mutual Funds Tax Saver & Fareeda Groww -> Ak ETMoney ---');

reopenForm1.investmentAccount = 'Mutual Funds Tax Saver';
reopenForm1.account = 'Mutual Funds Tax Saver';
reopenForm1.subAccount = 'Ak ETMoney';

const reversePayload = createInvSavePayload(reopenForm1, true, persistedRecord1);
const reversedTxn = db.updateTransaction(persistedRecord1.ID, reversePayload);

const persistedRecord2 = db.investment_transactions.get(createdTxn.ID);
assert.strictEqual(persistedRecord2.InvestmentAccount, 'Mutual Funds Tax Saver');
assert.strictEqual(persistedRecord2.SubAccount, 'Ak ETMoney');
assert.strictEqual(persistedRecord2.ToAccount, 'Mutual Funds Tax Saver');
assert.strictEqual(persistedRecord2.ToSubAccount, 'Ak ETMoney');

balances = db.calculateLedgerBalances();
console.log('Balances after Reverse Edit:', balances);
assert.strictEqual(balances['HDFC'], -500);
assert.strictEqual(balances['Mutual Funds Tax Saver'], 500);
assert.strictEqual(balances['Mutual Funds Tax Saver:Ak ETMoney'], 500);
assert.strictEqual(balances['Liquid Mutual Funds'] || 0, 0);
assert.strictEqual(balances['Liquid Mutual Funds:Fareeda Groww'] || 0, 0);

// ----------------------------------------------------
// TEST 4: Subaccount-only Edit:
// Mutual Funds Tax Saver -> Liquid Mutual Funds + Fareeda Groww -> Ammi Groww
// ----------------------------------------------------
console.log('\n--- 4. Subaccount-only Edit: Fareeda Groww -> Ammi Groww ---');
// First switch back to Liquid Mutual Funds
reopenForm1.investmentAccount = 'Liquid Mutual Funds';
reopenForm1.account = 'Liquid Mutual Funds';
reopenForm1.subAccount = 'Fareeda Groww';
const p1 = createInvSavePayload(reopenForm1, true, persistedRecord2);
db.updateTransaction(persistedRecord2.ID, p1);

// Now edit ONLY subaccount from Fareeda Groww to Ammi Groww
const editSubOnlyForm = hydrateEditForm(db.investment_transactions.get(createdTxn.ID), accounts);
assert.strictEqual(editSubOnlyForm.investmentAccount, 'Liquid Mutual Funds');
assert.strictEqual(editSubOnlyForm.subAccount, 'Fareeda Groww');

editSubOnlyForm.subAccount = 'Ammi Groww';
const subOnlyPayload = createInvSavePayload(editSubOnlyForm, true, db.investment_transactions.get(createdTxn.ID));
const subOnlyTxn = db.updateTransaction(createdTxn.ID, subOnlyPayload);

const persistedRecord3 = db.investment_transactions.get(createdTxn.ID);
assert.strictEqual(persistedRecord3.InvestmentAccount, 'Liquid Mutual Funds', 'Parent must stay Liquid Mutual Funds');
assert.strictEqual(persistedRecord3.SubAccount, 'Ammi Groww', 'Subaccount must become Ammi Groww');
assert.strictEqual(persistedRecord3.ToAccount, 'Liquid Mutual Funds');
assert.strictEqual(persistedRecord3.ToSubAccount, 'Ammi Groww');

balances = db.calculateLedgerBalances();
console.log('Balances after Subaccount-only edit:', balances);
assert.strictEqual(balances['Liquid Mutual Funds'], 500);
assert.strictEqual(balances['Liquid Mutual Funds:Ammi Groww'], 500);
assert.strictEqual(balances['Liquid Mutual Funds:Fareeda Groww'] || 0, 0);

// ----------------------------------------------------
// TEST 5: SELL transaction edit
// ----------------------------------------------------
console.log('\n--- 5. SELL Transaction Edit ---');
const sellForm = {
  type: 'SELL',
  investmentTransactionType: 'SELL',
  investmentAccount: 'Mutual Funds Tax Saver',
  account: 'Mutual Funds Tax Saver',
  subAccount: 'Ak ETMoney',
  fundingAccount: 'HDFC',
  settlementAccount: 'HDFC',
  securitySymbol: 'Motilal Oswal ELSS',
  note: 'Motilal Oswal ELSS',
  quantity: '10',
  unitPrice: '60',
  tradeValue: '600',
  costBasis: '500',
  realizedPnl: '100',
  date: '2026-09-02',
  time: '14:00'
};

const sellPayload = createInvSavePayload(sellForm, false);
const createdSell = db.addTransaction({ ...sellPayload, ID: 'txn_sell_001', _id: 'txn_sell_001' });

console.log('Created SELL in DB:', {
  InvestmentAccount: createdSell.InvestmentAccount,
  FromAccount: createdSell.FromAccount,
  ToAccount: createdSell.ToAccount,
  FromSubAccount: createdSell.FromSubAccount
});
assert.strictEqual(createdSell.InvestmentAccount, 'Mutual Funds Tax Saver');
assert.strictEqual(createdSell.FromAccount, 'Mutual Funds Tax Saver');
assert.strictEqual(createdSell.ToAccount, 'HDFC');
assert.strictEqual(createdSell.FromSubAccount, 'Ak ETMoney');

// Now edit SELL: change parent to Liquid Mutual Funds and subaccount to Fareeda Groww
const editSellForm = hydrateEditForm(createdSell, accounts);
editSellForm.investmentAccount = 'Liquid Mutual Funds';
editSellForm.account = 'Liquid Mutual Funds';
editSellForm.subAccount = 'Fareeda Groww';

const updatedSellPayload = createInvSavePayload(editSellForm, true, createdSell);
const updatedSell = db.updateTransaction(createdSell.ID, updatedSellPayload);

const persistedSell = db.investment_transactions.get(createdSell.ID);
console.log('Persisted SELL after Edit:', {
  InvestmentAccount: persistedSell.InvestmentAccount,
  FromAccount: persistedSell.FromAccount,
  ToAccount: persistedSell.ToAccount,
  FromSubAccount: persistedSell.FromSubAccount
});

assert.strictEqual(persistedSell.InvestmentAccount, 'Liquid Mutual Funds');
assert.strictEqual(persistedSell.FromAccount, 'Liquid Mutual Funds');
assert.strictEqual(persistedSell.ToAccount, 'HDFC');
assert.strictEqual(persistedSell.FromSubAccount, 'Fareeda Groww');
assert.strictEqual(persistedSell.SubAccount, 'Fareeda Groww');

console.log('\n========================================');
console.log('ALL TESTS IN THE SUITE PASSED WITH 100% SUCCESS!');
console.log('========================================\n');
