const fs = require('fs');
const { parseCSV } = require('../src/utils/csvParser.js');

console.log('=== RE-SERIALIZING 33,957 ROWS WITH RFC-4180 QUOTE ESCAPING ===\n');

const csvPath = 'finman_2026-09-05.csv';
const text = fs.readFileSync(csvPath, 'utf8');

// Parse rows using app RFC-4180 parser
const rows = parseCSV(text);
console.log(`Parsed logical rows from ${csvPath}: ${rows.length}`);

const headers = [
  'Date', 'Time', 'Account', 'AccountGroup', 'AccountType', 'CardLast4',
  'SettlementDate', 'PaymentDueDays', 'AccountOrder', 'AccountGroupOrder',
  'FromAccount', 'FromAccountGroup', 'FromAccountOrder', 'ToAccount', 'ToAccountGroup', 'ToAccountOrder',
  'Category', 'Subcategory', 'Note', 'Description',
  'INR', 'Amount', 'Currency', 'Income/Expense',
  'Tags', 'recurring_rule_id', 'warranty_expiry', 'serial_no', 'receipt_image', 'created_at', 'updated_at', 'ID',
  'SubAccount', 'FromSubAccount', 'ToSubAccount',
  'InvestmentTransactionType', 'Brokerage', 'SecuritySymbol', 'SecurityISIN',
  'Quantity', 'UnitPrice', 'TradeValue', 'CostBasis', 'CashImpact', 'PositionQuantityChange', 'RealizedPnl',
  'TradeId', 'OrderId', 'Exchange', 'Segment', 'Source'
];

function escapeCsvField(val) {
  const str = String(val ?? '');
  if (/[,"\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function serializeRow(rowObj) {
  return headers.map(h => escapeCsvField(rowObj[h])).join(',');
}

const headerRowString = headers.map(escapeCsvField).join(',');
const dataRowStrings = rows.map(serializeRow);
const finalCsvContent = '\ufeff' + [headerRowString, ...dataRowStrings].join('\n');

fs.writeFileSync(csvPath, finalCsvContent, 'utf8');
console.log(`Successfully re-serialized ${csvPath}! Total logical rows written: ${rows.length}`);
