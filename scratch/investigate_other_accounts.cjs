const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');

const rawCsv = fs.readFileSync(path.join(__dirname, '..', 'finman_2026-09-05.csv'), 'utf8');
const txns = parseCSV(rawCsv);

console.log('=== AUDITING OTHER ACCOUNT DIFFERENCES ===\n');

function auditAccount(acctName) {
  let bal = 0;
  let count = 0;
  const list = [];

  txns.forEach((t, i) => {
    const amt = parseFloat(t.INR || t.inr || t.Amount || t.amount || 0);
    const type = String(t['Income/Expense'] || t.type || '').trim();
    const acct = String(t.Account || t.FromAccount || '').trim();
    const dest = String(t.ToAccount || '').trim();

    let change = 0;
    if (type === 'Income') {
      if ((dest || acct) === acctName) change = amt;
    } else if (type === 'Expense') {
      if ((acct || fromAcct) === acctName) change = -amt;
    } else if (type === 'Transfer-Out') {
      if (acct === acctName) change = -amt;
      if (dest === acctName) change = amt;
    }

    if (change !== 0) {
      bal += change;
      count++;
      list.push({ line: i + 2, id: t.ID || t.id, date: t.Date, type, note: t.Note || t.Description, change, runningBal: bal });
    }
  });

  return { acctName, finalBal: bal, txnCount: count, list };
}

const acctsToAudit = ['Canara', 'HDFC', 'Stock', 'Cash', 'Lend', 'Amazon'];
acctsToAudit.forEach(a => {
  const r = auditAccount(a);
  console.log(`Account: ${r.acctName.padEnd(10)} | CSV Derived Ledger Balance: ₹${r.finalBal.toFixed(2)} | Txn Count: ${r.txnCount}`);
});

console.log('\n--- CANARA RECENT TRANSACTIONS (Top 25) ---');
const canaraAudit = auditAccount('Canara');
console.log(`Canara Total Balance: ₹${canaraAudit.finalBal.toFixed(2)}`);

// Let's check differences vs earlier screen values:
// Canara: 471,673 vs 434,620 (Diff = +37,053)
// HDFC: 397,013 vs 391,593 (Diff = +5,420)
// Stock: 6,578 vs 5,824 (Diff = +754)
// Cash: 10,435 vs 9,109 (Diff = +1,326)
// Lend: 2,365 vs 1,066 (Diff = +1,299)
// Amazon: 7,618 vs 7,668 (Diff = -50)

console.log('\n--- SEARCHING CANARA FOR COMBINATIONS THAT SUM TO ₹37,053 ---');
// Let's check transactions in Canara with large changes or recent transactions that account for 37,053
const canaraTxns = canaraAudit.list;
console.log(`Canara total transactions: ${canaraTxns.length}`);
canaraTxns.slice(-20).forEach(t => {
  console.log(`Line ${t.line} (ID ${t.id}): Date=${t.date}, Type=${t.type}, Change=${t.change}, Note="${t.note}", RunningBal=${t.runningBal.toFixed(2)}`);
});
