const fs = require('fs');

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

async function testSubAccountCashAccounting() {
  const { resolveInvestmentSubAccount } = await import('../src/utils/brokerageAccounting.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());

  const KNOWN_INVESTMENT_PLATFORMS = new Set([
    'Fareeda Groww', 'Ammi Groww', 'Fareeda ETMoney', 'Ak ETMoney', 'Zerodha', 'Groww', 'ETMoney', 'Scripbox'
  ]);

  for (const t of txns) {
    const amt = parseFloat(t.INR || t.Amount || 0) || 0;
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

    // Bank accounts must NEVER inherit investment platforms as their subaccounts
    let resolvedFromSub = fromSub && fromSub !== 'Default' ? fromSub : '';
    if (isFromInv) {
      resolvedFromSub = fromSub && fromSub !== 'Default' ? fromSub : resolveInvestmentSubAccount(t, fromAcct) || sub;
    } else if (!resolvedFromSub && sub && !KNOWN_INVESTMENT_PLATFORMS.has(sub)) {
      resolvedFromSub = sub;
    }

    let resolvedToSub = toSub && toSub !== 'Default' ? toSub : '';
    if (isDestInv) {
      resolvedToSub = toSub && toSub !== 'Default' ? toSub : resolveInvestmentSubAccount(t, dest) || sub;
    } else if (!resolvedToSub && sub && !KNOWN_INVESTMENT_PLATFORMS.has(sub)) {
      resolvedToSub = sub;
    }

    let resolvedAcctSub = sub && sub !== 'Default' ? sub : '';
    if (isAcctInv) {
      resolvedAcctSub = resolveInvestmentSubAccount(t, acct) || sub;
    } else if (KNOWN_INVESTMENT_PLATFORMS.has(resolvedAcctSub)) {
      resolvedAcctSub = '';
    }

    // Cash Ledger SubAccount accounting uses cash amount `amt`, exactly like buildBalanceMap
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

  console.log('=== RESULTS WITH CLEAN CASH SUBACCOUNT ACCOUNTING ===');
  console.log('Liquid Mutual Funds:', map['Liquid Mutual Funds']);
  console.log('Mutual Funds Tax Saver:', map['Mutual Funds Tax Saver']);
  console.log('Canara:', map['Canara']);
  console.log('HDFC:', map['HDFC']);
  console.log('SBI:', map['SBI']);
}

testSubAccountCashAccounting();
