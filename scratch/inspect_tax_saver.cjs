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

async function inspectTaxSaver() {
  const { resolveInvestmentSubAccount } = await import('../src/utils/brokerageAccounting.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

  let parentBal = 0;
  let subBal = 0;

  console.log('=== Mutual Funds Tax Saver transactions ===');
  for (const t of txns) {
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();
    const sub = String(t.SubAccount || '').trim();
    const fromSub = String(t.FromSubAccount || '').trim();
    const toSub = String(t.ToSubAccount || '').trim();
    const invType = String(t.InvestmentTransactionType || '').trim().toUpperCase();
    const type = String(t['Income/Expense'] || '').trim();
    const amt = parseFloat(t.INR || t.Amount || 0) || 0;
    const tradeVal = parseFloat(t.TradeValue || amt) || amt;

    const isFromInv = fromAcct === 'Mutual Funds Tax Saver';
    const isDestInv = dest === 'Mutual Funds Tax Saver';
    const isAcctInv = acct === 'Mutual Funds Tax Saver';

    const resolvedFromSub = (fromSub && fromSub !== 'Default') ? fromSub : (isFromInv ? resolveInvestmentSubAccount(t, fromAcct) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedToSub = (toSub && toSub !== 'Default') ? toSub : (isDestInv ? resolveInvestmentSubAccount(t, dest) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedAcctSub = (sub && sub !== 'Default') ? sub : (isAcctInv ? resolveInvestmentSubAccount(t, acct) : '');

    // Parent calculation
    let pImpact = 0;
    if (type === 'Income' && (dest === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver')) pImpact += amt;
    else if (type === 'Expense' && (fromAcct === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver')) pImpact -= amt;
    else if (type === 'Transfer-Out') {
      if (fromAcct === 'Mutual Funds Tax Saver') pImpact -= amt;
      if (dest === 'Mutual Funds Tax Saver') pImpact += amt;
    }
    parentBal += pImpact;

    // Subaccount calculation according to buildSubAccountBalanceMap
    let sImpact = 0;
    if (invType === 'BUY') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver') sImpact += (tradeVal || amt);
    } else if (invType === 'SELL') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver') sImpact -= (tradeVal || amt);
    } else if (type === 'Income') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver') sImpact += amt;
    } else if (type === 'Expense') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === 'Mutual Funds Tax Saver') sImpact -= amt;
    } else if (type === 'Transfer-Out') {
      if (fromAcct === 'Mutual Funds Tax Saver') sImpact -= amt;
      if (dest === 'Mutual Funds Tax Saver') sImpact += amt;
    }
    subBal += sImpact;

    if (pImpact !== 0 || sImpact !== 0) {
      if (pImpact !== sImpact) {
        console.log(`MISMATCH Line ${t._line} | Date: ${t.Date} | Type: ${type} | InvType: ${invType} | Acct: ${fromAcct} -> ${dest} | Amt: ${amt} | TradeVal: ${tradeVal} | pImpact: ${pImpact} | sImpact: ${sImpact} | Note: ${t.Note}`);
      }
    }
  }

  console.log(`\nFinal Parent Bal: ${parentBal}`);
  console.log(`Final Sub Bal (Ak ETMoney): ${subBal}`);
}

inspectTaxSaver();
