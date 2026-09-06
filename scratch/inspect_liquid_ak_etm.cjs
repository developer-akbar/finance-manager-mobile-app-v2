const fs = require('fs');
const path = require('path');

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

async function inspectLiquidAkEtm() {
  const { resolveInvestmentSubAccount } = await import('../src/utils/brokerageAccounting.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

  console.log('=== Liquid Mutual Funds transactions where sub is Ak ETMoney ===');
  let net = 0;
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

    const resolvedFromSub = (fromSub && fromSub !== 'Default') ? fromSub : (fromAcct === 'Liquid Mutual Funds' ? resolveInvestmentSubAccount(t, fromAcct) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedToSub = (toSub && toSub !== 'Default') ? toSub : (dest === 'Liquid Mutual Funds' ? resolveInvestmentSubAccount(t, dest) : (sub && sub !== 'Default' ? sub : ''));
    const resolvedAcctSub = (sub && sub !== 'Default') ? sub : (acct === 'Liquid Mutual Funds' ? resolveInvestmentSubAccount(t, acct) : '');

    let impact = 0;
    let matches = false;

    if (invType === 'BUY') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === 'Liquid Mutual Funds' && targetSub === 'Ak ETMoney') {
        impact += (tradeVal || amt);
        matches = true;
      }
    } else if (invType === 'SELL') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === 'Liquid Mutual Funds' && targetSub === 'Ak ETMoney') {
        impact -= (tradeVal || amt);
        matches = true;
      }
    } else if (type === 'Income') {
      const targetAcct = dest || acct;
      const targetSub = dest ? resolvedToSub : resolvedAcctSub;
      if (targetAcct === 'Liquid Mutual Funds' && targetSub === 'Ak ETMoney') {
        impact += amt;
        matches = true;
      }
    } else if (type === 'Expense') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromAcct ? resolvedFromSub : resolvedAcctSub;
      if (targetAcct === 'Liquid Mutual Funds' && targetSub === 'Ak ETMoney') {
        impact -= amt;
        matches = true;
      }
    } else if (type === 'Transfer-Out') {
      if (fromAcct === 'Liquid Mutual Funds' && resolvedFromSub === 'Ak ETMoney') {
        impact -= amt;
        matches = true;
      }
      if (dest === 'Liquid Mutual Funds' && resolvedToSub === 'Ak ETMoney') {
        impact += amt;
        matches = true;
      }
    }

    if (matches) {
      net += impact;
      console.log(`Line ${t._line} | Date: ${t.Date} | Type: ${type} | InvType: ${invType} | Acct: ${fromAcct} -> ${dest} | Sub: ${sub} | FromSub: ${fromSub} | ToSub: ${toSub} | Amt: ${amt} | TradeVal: ${tradeVal} | Impact: ${impact} | RunNet: ${net} | Note: ${t.Note}`);
    }
  }
}

inspectLiquidAkEtm();
