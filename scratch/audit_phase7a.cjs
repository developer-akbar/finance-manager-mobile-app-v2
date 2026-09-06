const fs = require('fs');
const path = require('path');

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
  return data;
}

async function auditPhase7a() {
  const csvPath = path.resolve('finman_2026-09-02.csv');
  const txns = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Loaded ${txns.length} transactions from finman_2026-09-02.csv`);

  // Let's import resolveInvestmentSubAccount from brokerageAccounting.js
  const { resolveInvestmentSubAccount } = await import('../src/utils/brokerageAccounting.js');

  // Let's inspect how buildSubAccountBalanceMap calculates balances
  function txnAmount(t) {
    const amt = parseFloat(t.INR || t.Amount || 0);
    return isNaN(amt) ? 0 : amt;
  }

  const map = {};
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
      if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
        if (!map[targetAcct]) map[targetAcct] = {};
        map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) + (tradeVal || amt);
      }
    } else if (invType === 'SELL') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
        if (!map[targetAcct]) map[targetAcct] = {};
        map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) - (tradeVal || amt);
      }
    } else if (type === 'Income') {
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

  console.log('\n--- 1. SubAccount Balances for Liquid Mutual Funds ---');
  console.log(map['Liquid Mutual Funds']);

  console.log('\n--- 2. SubAccount Balances for Mutual Funds Tax Saver ---');
  console.log(map['Mutual Funds Tax Saver']);

  console.log('\n--- 3. SubAccounts under Bank Accounts (Canara, HDFC, SBI) ---');
  console.log('Canara:', map['Canara']);
  console.log('HDFC:', map['HDFC']);
  console.log('SBI:', map['SBI']);

  // Let's inspect why Canara/HDFC/SBI has these subaccounts
  console.log('\n--- Inspecting why Canara has subaccounts in map ---');
  const canaraSubs = {};
  for (const t of txns) {
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();
    const sub = String(t.SubAccount || t.sub_account || '').trim();
    const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
    const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();
    const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();

    if (fromAcct === 'Canara' || acct === 'Canara' || dest === 'Canara') {
      if (sub || fromSub || toSub) {
        const key = `sub:${sub}|fromSub:${fromSub}|toSub:${toSub}|type:${t['Income/Expense']}|invType:${invType}|dest:${dest}`;
        canaraSubs[key] = (canaraSubs[key] || 0) + 1;
      }
    }
  }
  console.log('Canara sample transaction patterns with subaccounts:', Object.entries(canaraSubs).slice(0, 10));
}

auditPhase7a();
