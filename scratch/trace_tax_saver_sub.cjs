const fs = require('fs');

function parseCSV(text) {
  const lines = text.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = [];
    let inQ = false, cur = '';
    for (let j = 0; j < lines[i].length; j++) {
      const c = lines[i][j];
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { row.push(cur); cur = ''; }
      else cur += c;
    }
    row.push(cur);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx] ? row[idx].trim().replace(/^\"|\"$/g, '') : '');
    obj._line = i + 1;
    rows.push(obj);
  }
  return rows;
}

async function traceTaxSaverSub() {
  const { resolveInvestmentSubAccount } = await import('../src/utils/brokerageAccounting.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

  let running = 0;
  for (const t of txns) {
    const amt = parseFloat(t.INR || t.Amount || 0) || 0;
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();
    const invType = String(t.InvestmentTransactionType || '').trim().toUpperCase();
    const tradeVal = parseFloat(t.TradeValue || amt) || amt;

    const sub = String(t.SubAccount || '').trim();
    const fromSub = String(t.FromSubAccount || '').trim();
    const toSub = String(t.ToSubAccount || '').trim();

    const isFromInv = fromAcct === 'Mutual Funds Tax Saver';
    const isDestInv = dest === 'Mutual Funds Tax Saver';
    const isAcctInv = acct === 'Mutual Funds Tax Saver';

    const resolvedFromSub = (fromSub && fromSub !== 'Default') ? fromSub : (isFromInv ? resolveInvestmentSubAccount(t, fromAcct) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedToSub = (toSub && toSub !== 'Default') ? toSub : (isDestInv ? resolveInvestmentSubAccount(t, dest) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedAcctSub = (sub && sub !== 'Default') ? sub : (isAcctInv ? resolveInvestmentSubAccount(t, acct) : '');

    let diff = 0;
    if (invType === 'BUY') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver' && targetSub === 'Ak ETMoney') {
        diff += (tradeVal || amt);
      }
    } else if (invType === 'SELL') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver' && targetSub === 'Ak ETMoney') {
        diff -= (tradeVal || amt);
      }
    } else if (type === 'Income') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver' && targetSub === 'Ak ETMoney') {
        diff += amt;
      }
    } else if (type === 'Expense') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver' && targetSub === 'Ak ETMoney') {
        diff -= amt;
      }
    } else if (type === 'Transfer-Out') {
      if (fromAcct === 'Mutual Funds Tax Saver' && resolvedFromSub === 'Ak ETMoney') {
        diff -= amt;
      }
      if (dest === 'Mutual Funds Tax Saver' && resolvedToSub === 'Ak ETMoney') {
        diff += amt;
      }
    }

    if (diff !== 0) {
      running += diff;
      console.log(`Line ${t._line} | Date: ${t.Date} | Type: ${type} | InvType: ${invType} | ${fromAcct} -> ${dest} | amt: ${amt} | tradeVal: ${tradeVal} | diff: ${diff} | running: ${running} | Note: ${t.Note}`);
    }
  }
}

traceTaxSaverSub();
