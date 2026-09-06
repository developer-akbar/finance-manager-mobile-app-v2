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

function computeBalance(txns, acctName) {
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

const baseTxns = parseCSV(fs.readFileSync(file, 'utf8'));

function runSimulation(label, newTxn) {
  const allTxns = [...baseTxns, newTxn];
  const acctName = 'Liquid Mutual Funds';
  const subAccountName = 'Ammi Groww';

  // AccountDetail filter:
  const acctTxns = allTxns.filter(t => {
    return isInvestmentTransactionForSubAccount(t, acctName, subAccountName);
  });

  const viewYear = 2026;
  const viewMonth = 8; // September
  const period = 'Month';

  const periodTxns = acctTxns.filter(t => {
    const d = parseDate(t.Date);
    return d.getFullYear() === viewYear && d.getMonth() === viewMonth;
  });

  const beforePeriod = acctTxns.filter(t => {
    const d = parseDate(t.Date);
    return !(d.getFullYear() === viewYear && d.getMonth() === viewMonth) && d < new Date(viewYear, viewMonth, 1);
  });

  const openingBal = computeBalance(beforePeriod, acctName);
  const periodBal = computeBalance(periodTxns, acctName);
  const closingBal = openingBal + periodBal;

  console.log(`=== ${label} ===`);
  console.log('Total acctTxns:', acctTxns.length);
  console.log('periodTxns count:', periodTxns.length);
  console.log('beforePeriod count:', beforePeriod.length);
  console.log('Opening Balance: ', openingBal);
  console.log('Period Balance:  ', periodBal);
  console.log('Closing Balance: ', closingBal);
}

// Scenario A: HDFC funding
runSimulation('SCENARIO A: Funded from HDFC', {
  Date: '02/09/2026',
  Account: 'HDFC',
  FromAccount: 'HDFC',
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
});

// Scenario B: No separate funding bank account
runSimulation('SCENARIO B: Internal / No separate funding bank account', {
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
  FromSubAccount: 'Ammi Groww',
  Brokerage: 'Ammi Groww',
  InvestmentTransactionType: 'BUY',
  TradeValue: 100,
  Note: 'DSP ELSS'
});
