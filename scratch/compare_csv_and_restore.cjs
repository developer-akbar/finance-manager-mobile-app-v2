const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');

const oldPath = path.join(__dirname, '..', 'finman_2026-09-05_old.csv');
const newPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');

const oldRaw = fs.readFileSync(oldPath, 'utf8');
const newRaw = fs.readFileSync(newPath, 'utf8');

const oldTxns = parseCSV(oldRaw);
// Re-read current working CSV without the restored ones if needed, or filter by ID
const newTxns = parseCSV(newRaw).filter(t => !oldTxns.some(o => o.ID === t.ID) || new Map(parseCSV(fs.readFileSync(oldPath, 'utf8')).map(x => [x.ID, x])).has(t.ID) === false || ['850da72c-d728-40eb-8e4a-6ea70e3ead7c', '5332c24d-477b-4019-978c-2365fc228078', '89a16542-fa43-4b90-9ba7-a404f6ce2a97', 'fcd85e24-0528-412e-87df-dc7430d74650'].includes(t.ID));

const oldMap = new Map();
oldTxns.forEach(t => { if (t.ID) oldMap.set(t.ID, t); });

// Superseded Old IDs to exclude:
// 4 standard replaced IDs + b407b3e4-3a2d-41d1-b699-65f742906aa3 (represented by fcd85e24-0528-412e-87df-dc7430d74650)
const supersededOldIds = new Set([
  '8940a519-5357-4a83-8a35-b118c35b14c1',
  '8279536a-5d7e-49fd-b2cc-ea52207ce9b7',
  'c14a65be-f113-4623-9d88-084751de01d7',
  '8168af65-f56d-4b56-b7f0-b02e7e304113',
  'b407b3e4-3a2d-41d1-b699-65f742906aa3'
]);

// Build clean merged list:
// Start with baseline 28,860 transactions
const baseTxns = parseCSV(newRaw).filter(t => !oldMap.has(t.ID) || ['850da72c-d728-40eb-8e4a-6ea70e3ead7c', '5332c24d-477b-4019-978c-2365fc228078', '89a16542-fa43-4b90-9ba7-a404f6ce2a97', 'fcd85e24-0528-412e-87df-dc7430d74650'].includes(t.ID));

const existingIds = new Set(baseTxns.map(t => t.ID));
const restoreList = [];

oldMap.forEach((t, id) => {
  if (!existingIds.has(id) && !supersededOldIds.has(id)) {
    restoreList.push(t);
  }
});

console.log(`Base AG transactions: ${baseTxns.length}`);
console.log(`Genuine Old transactions restored: ${restoreList.length}`);

const mergedTxns = [...baseTxns, ...restoreList];
console.log(`Total Merged logical transactions: ${mergedTxns.length}`);

const headers = [
  'Date', 'Time', 'Account', 'AccountGroup', 'AccountType', 'CardLast4',
  'SettlementDate', 'PaymentDueDays', 'AccountOrder', 'AccountGroupOrder',
  'FromAccount', 'FromAccountGroup', 'FromAccountOrder', 'ToAccount',
  'ToAccountGroup', 'ToAccountOrder', 'Category', 'Subcategory', 'Note',
  'Description', 'INR', 'Amount', 'Currency', 'Income/Expense', 'Tags',
  'recurring_rule_id', 'warranty_expiry', 'serial_no', 'receipt_image',
  'created_at', 'updated_at', 'ID', 'SubAccount', 'FromSubAccount',
  'ToSubAccount', 'InvestmentTransactionType', 'Brokerage', 'SecuritySymbol',
  'SecurityISIN', 'Quantity', 'UnitPrice', 'TradeValue', 'CostBasis',
  'CashImpact', 'PositionQuantityChange', 'RealizedPnl', 'TradeId',
  'OrderId', 'Exchange', 'Segment', 'Source'
];

function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[,"\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

const csvLines = [headers.join(',')];
mergedTxns.forEach(t => {
  const row = headers.map(h => escapeCsvField(t[h] !== undefined ? t[h] : ''));
  csvLines.push(row.join(','));
});

fs.writeFileSync(newPath, csvLines.join('\n'), 'utf8');
console.log(`Successfully wrote ${mergedTxns.length} records to finman_2026-09-05.csv`);

