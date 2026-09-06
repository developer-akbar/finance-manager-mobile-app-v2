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

async function inspectTaxSaverDetails() {
  const { resolveInvestmentSubAccount } = await import('../src/utils/brokerageAccounting.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

  for (const t of txns) {
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();
    const invType = String(t.InvestmentTransactionType || '').trim().toUpperCase();
    const type = String(t['Income/Expense'] || '').trim();

    if (acct === 'Mutual Funds Tax Saver' || fromAcct === 'Mutual Funds Tax Saver' || dest === 'Mutual Funds Tax Saver') {
      const amt = parseFloat(t.INR || t.Amount || 0) || 0;
      const tradeVal = parseFloat(t.TradeValue || amt) || amt;
      console.log(`Line ${t._line} | Date: ${t.Date} | Type: ${type} | InvType: ${invType} | Acct: ${fromAcct} -> ${dest} | Sub: ${t.SubAccount} | FromSub: ${t.FromSubAccount} | ToSub: ${t.ToSubAccount} | Amt: ${amt} | TradeVal: ${tradeVal} | CostBasis: ${t.CostBasis} | Note: ${t.Note}`);
    }
  }
}

inspectTaxSaverDetails();
