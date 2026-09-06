import fs from 'fs';
import { resolveInvestmentSubAccount } from '../src/utils/brokerageAccounting.js';

// Parse CSV
function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // regex parser to handle quotes
    const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
    const values = [];
    let match;
    while ((match = regex.exec(lines[i])) !== null) {
      if (match.index === regex.lastIndex) regex.lastIndex++;
      values.push(match[1] !== undefined ? match[1] : match[2]);
    }
    if (values.length > headers.length) values.length = headers.length;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (values[idx] || '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

const csvFiles = [
  'finman_2026-09-01.csv',
  'finman_2026-08-31_Zerodha_final_v2.csv',
  'finman_2026-08-30_shares_data.csv',
  'scratch/finman_CAS_enriched_master_preview_v2.csv'
];

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

for (const file of csvFiles) {
  if (fs.existsSync(file)) {
    const txns = parseCSV(fs.readFileSync(file, 'utf8'));
    const subMap = buildSubAccountBalanceMap(txns);
    console.log(`\n=== File: ${file} (total txns: ${txns.length}) ===`);
    if (subMap['Liquid Mutual Funds']) {
      console.log('Liquid Mutual Funds:', subMap['Liquid Mutual Funds']);
    }
    if (subMap['Mutual Funds Tax Saver']) {
      console.log('Mutual Funds Tax Saver:', subMap['Mutual Funds Tax Saver']);
    }
  }
}
