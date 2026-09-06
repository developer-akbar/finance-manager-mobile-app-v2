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

function txnAmount(t) {
  return parseFloat(t.INR || t.Amount || 0);
}

function buildSubAccountBalanceMap(transactions) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());

  for (const t of transactions) {
    const amt = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();

    const sub = String(t.SubAccount || t.sub_account || '').trim();
    const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
    const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

    // Canonical subaccount resolution for investment accounts
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

const file = fs.existsSync('scratch/finman_reconstructed_master_preview_v4_2.csv')
  ? 'scratch/finman_reconstructed_master_preview_v4_2.csv'
  : 'scratch/finman_reconstructed_master_preview_v4.csv';

const baseTxns = parseCSV(fs.readFileSync(file, 'utf8'));

// TEST 1: BUY into Fareeda Groww
const fareedaBuy = {
  Date: '02/09/2026',
  Account: 'HDFC',
  FromAccount: 'HDFC',
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

const mapAfterTest1 = buildSubAccountBalanceMap([...baseTxns, fareedaBuy]);
console.log('After Test 1 (Fareeda BUY):', mapAfterTest1['Liquid Mutual Funds']);

// TEST 2: BUY into Ammi Groww
const ammiBuy = {
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
};

const mapAfterTest2 = buildSubAccountBalanceMap([...baseTxns, fareedaBuy, ammiBuy]);
console.log('After Test 2 (Ammi BUY):', mapAfterTest2['Liquid Mutual Funds']);
