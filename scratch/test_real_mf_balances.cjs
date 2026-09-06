const fs = require('fs');

// Read finman_2026-08-30_shares_data.csv to test subaccount resolution on real data
const csvData = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const lines = csvData.split('\n').map(l => l.trim()).filter(Boolean);
const headers = lines[0].split(',');

console.log('Total transactions in CSV:', lines.length - 1);

function parseLine(line) {
  // Simple regex CSV parser
  const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
  const values = [];
  let match;
  while ((match = regex.exec(line)) !== null) {
    if (match.index === regex.lastIndex) regex.lastIndex++;
    values.push(match[1] !== undefined ? match[1] : match[2]);
  }
  // Remove empty match if trailing comma
  if (values.length > headers.length) values.length = headers.length;
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = values[i] || '';
  });
  return obj;
}

const txns = [];
for (let i = 1; i < lines.length; i++) {
  txns.push(parseLine(lines[i]));
}

// Check Mutual Funds Tax Saver transactions
const mfTaxTxns = txns.filter(t => 
  t.Account === 'Mutual Funds Tax Saver' || 
  t.FromAccount === 'Mutual Funds Tax Saver' || 
  t.ToAccount === 'Mutual Funds Tax Saver' || 
  t.Category === 'Mutual Funds Tax Saver'
);

console.log('Mutual Funds Tax Saver txns count:', mfTaxTxns.length);

let totalTaxSaver = 0;
mfTaxTxns.forEach(t => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'];
  const fromAcct = t.FromAccount || t.Account;
  const dest = t.ToAccount;
  if (type === 'Transfer-Out') {
    if (dest === 'Mutual Funds Tax Saver') totalTaxSaver += amt;
    if (fromAcct === 'Mutual Funds Tax Saver') totalTaxSaver -= amt;
  } else if (type === 'Income' && (dest === 'Mutual Funds Tax Saver' || t.Account === 'Mutual Funds Tax Saver')) {
    totalTaxSaver += amt;
  } else if (type === 'Expense' && (fromAcct === 'Mutual Funds Tax Saver' || t.Account === 'Mutual Funds Tax Saver')) {
    totalTaxSaver -= amt;
  }
});

console.log('Calculated ledger balance for Mutual Funds Tax Saver:', totalTaxSaver);

// Check Liquid Mutual Funds transactions
const lmfTxns = txns.filter(t => 
  t.Account === 'Liquid Mutual Funds' || 
  t.FromAccount === 'Liquid Mutual Funds' || 
  t.ToAccount === 'Liquid Mutual Funds' || 
  t.Category === 'Liquid Mutual Funds'
);

console.log('Liquid Mutual Funds txns count:', lmfTxns.length);

let totalLmf = 0;
lmfTxns.forEach(t => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'];
  const fromAcct = t.FromAccount || t.Account;
  const dest = t.ToAccount;
  if (type === 'Transfer-Out') {
    if (dest === 'Liquid Mutual Funds') totalLmf += amt;
    if (fromAcct === 'Liquid Mutual Funds') totalLmf -= amt;
  } else if (type === 'Income' && (dest === 'Liquid Mutual Funds' || t.Account === 'Liquid Mutual Funds')) {
    totalLmf += amt;
  } else if (type === 'Expense' && (fromAcct === 'Liquid Mutual Funds' || t.Account === 'Liquid Mutual Funds')) {
    totalLmf -= amt;
  }
});

console.log('Calculated ledger balance for Liquid Mutual Funds:', totalLmf);
