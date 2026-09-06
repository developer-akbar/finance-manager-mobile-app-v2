const fs = require('fs');
const assert = require('assert');
const { parseCSV } = require('../src/utils/csvParser.js');

console.log('=== RE-SERIALIZING CANONICAL CSV WITH STRICT RFC-4180 COMPLIANCE ===\n');

// 1. Read baseline uncorrupted records from finman_2026-09-02.csv
const baseFile = 'finman_2026-09-02.csv';
const baseText = fs.readFileSync(baseFile, 'utf8');
const baseRows = parseCSV(baseText);

console.log(`Baseline valid logical rows in ${baseFile}: ${baseRows.length}`);

// Headers list
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

// Deep copy rows
const cleanRows = baseRows.map(r => ({ ...r }));

// Replace legacy unparsed Lalithaa row (Row 112) with explicit Lalithaa BUY trade
const laliLegacyIdx = cleanRows.findIndex(r => (r.Note || r.Description || '').includes('Lalitha Jewellery Mart'));
const laliBuyTrade = {
  ID: laliLegacyIdx !== -1 ? cleanRows[laliLegacyIdx].ID : '56b665f6-e40a-4cb3-950d-97071a91d860',
  Date: '02/09/2026', Time: '10:00', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww',
  Note: 'Lalithaa Jewel.Mart', Description: 'Lalithaa Jewels IPO — 74 @ ₹201 — Fareeda Groww',
  INR: '14874', Amount: '14874', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'BUY',
  Brokerage: 'Fareeda Groww', SecuritySymbol: 'LALITHAA JEWEL.MART', Quantity: '74', UnitPrice: '201',
  TradeValue: '14874', CostBasis: '14874', CashImpact: '-14874', RealizedPnl: '0'
};
if (laliLegacyIdx !== -1) cleanRows[laliLegacyIdx] = laliBuyTrade;
else cleanRows.push(laliBuyTrade);

// Replace legacy unparsed Gold/Silver row (Row 1929) with explicit Gold BeES BUY trade
const gsLegacyIdx = cleanRows.findIndex(r => (r.Note || r.Description || '') === 'Gold/Silver');
const goldBuyTrade = {
  ID: gsLegacyIdx !== -1 ? cleanRows[gsLegacyIdx].ID : 'gb011111-9613-4d03-be47-f299878e3ee9',
  Date: '27/01/2026', Time: '10:00', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww',
  Note: 'Nippon India ETF Gold BeES', Description: 'Nippon India ETF Gold BeES — 25 @ ₹131 — Fareeda Groww',
  INR: '3281', Amount: '3281', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'BUY',
  Brokerage: 'Fareeda Groww', SecuritySymbol: 'Nippon India ETF Gold BeES', SecurityISIN: 'INF204KB17I5',
  Quantity: '25', UnitPrice: '131', TradeValue: '3275', CostBasis: '3281', CashImpact: '-3281', RealizedPnl: '0'
};
if (gsLegacyIdx !== -1) cleanRows[gsLegacyIdx] = goldBuyTrade;
else cleanRows.push(goldBuyTrade);

// Add DDPI Charge ₹118 Expense if not present
let ddpiRow = cleanRows.find(r => (r.Note || r.note || '').includes('DDPI') || (r.Description || r.description || '').includes('DDPI'));
if (!ddpiRow) {
  ddpiRow = {
    Date: '31/08/2026', Time: '10:00', Account: 'Share Market', FromAccount: 'Share Market', FromAccountGroup: 'Investments',
    ToAccount: 'Fareeda Groww', ToAccountGroup: 'Investments', Category: 'Share Market', Subcategory: 'Share Market',
    Note: 'DDPI Charges', Description: 'DDPI Charges', INR: '118', Amount: '118', Currency: 'INR',
    'Income/Expense': 'Expense', Tags: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ID: 'fa2cad7d-2a8f-461e-8f7b-89dabe912237', SubAccount: 'Fareeda Groww', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww',
    InvestmentTransactionType: '', Brokerage: 'Fareeda Groww', SecuritySymbol: '', SecurityISIN: '',
    Quantity: '0', UnitPrice: '0', TradeValue: '0', CostBasis: '0', CashImpact: '-118', PositionQuantityChange: '0', RealizedPnl: '0'
  };
  cleanRows.push(ddpiRow);
}

// Add remaining explicit stock trades
const explicitTrades = [
  // SilverBeES ETF
  { ID: 'cf22694f-24ba-4534-becf-eecc645fa497', Date: '27/01/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'SILVERBEES', Description: 'SILVERBEES — 5 @ ₹335 — Fareeda Groww', INR: '1681', Amount: '1681', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'BUY', Brokerage: 'Fareeda Groww', SecuritySymbol: 'SILVERBEES', SecurityISIN: 'INF204KC1402', Quantity: '5', UnitPrice: '335', TradeValue: '1675', CostBasis: '1681', CashImpact: '-1681', RealizedPnl: '0' },
  // Indiabulls
  { ID: 'fb011111-9613-4d03-be47-f299878e3ee9', Date: '14/07/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'INDIABULLS', Description: 'Indiabulls — 100 @ ₹31.67 — Fareeda Groww', INR: '3176', Amount: '3176', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'BUY', Brokerage: 'Fareeda Groww', SecuritySymbol: 'INDIABULLS', Quantity: '100', UnitPrice: '31.67', TradeValue: '3167', CostBasis: '3176', CashImpact: '-3176', RealizedPnl: '0' },
  { ID: 'fb011112-9613-4d03-be47-f299878e3ee9', Date: '14/07/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'INDIABULLS', Description: 'Indiabulls — 100 @ ₹25.44 — Fareeda Groww', INR: '2511.70', Amount: '2511.70', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'SELL', Brokerage: 'Fareeda Groww', SecuritySymbol: 'INDIABULLS', Quantity: '100', UnitPrice: '25.44', TradeValue: '2544', CostBasis: '3176', CashImpact: '2511.70', RealizedPnl: '-664.30' },
  // Lalithaa SELL
  { ID: '56b665f6-e40a-4cb3-950d-97071a91d861', Date: '02/09/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'Lalithaa Jewel.Mart', Description: 'Lalithaa Jewels — Delivery — 74 @ ₹271.16 — Fareeda Groww', INR: '19998.03', Amount: '19998.03', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'SELL', Brokerage: 'Fareeda Groww', SecuritySymbol: 'LALITHAA JEWEL.MART', Quantity: '74', UnitPrice: '271.16', TradeValue: '20065.84', CostBasis: '14874', CashImpact: '19998.03', RealizedPnl: '5124.03' },
  // Lumino BUY & SELL
  { ID: '67c776f7-f5ba-5dc4-061e-08182b02e970', Date: '03/09/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'Lumino Industries', Description: 'Lumino Industries IPO — 182 @ ₹82 — Fareeda Groww', INR: '14924', Amount: '14924', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'BUY', Brokerage: 'Fareeda Groww', SecuritySymbol: 'LUMINO INDUSTRIES', Quantity: '182', UnitPrice: '82', TradeValue: '14924', CostBasis: '14924', CashImpact: '-14924', RealizedPnl: '0' },
  { ID: '67c776f7-f5ba-5dc4-061e-08182b02e971', Date: '03/09/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'Lumino Industries', Description: 'Lumino Industries — Delivery — Limit — 182 @ ₹112.11 — Fareeda Groww', INR: '20336.34', Amount: '20336.34', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'SELL', Brokerage: 'Fareeda Groww', SecuritySymbol: 'LUMINO INDUSTRIES', Quantity: '182', UnitPrice: '112.11', TradeValue: '20404.02', CostBasis: '14924', CashImpact: '20336.34', RealizedPnl: '5412.34' },
  // ESDS BUY & SELL
  { ID: '78d887a8-a6cb-6ed5-172f-19293c03fa80', Date: '04/09/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'ESDD Software Solun', Description: 'ESDS Software Solutions IPO — 34 @ ₹429 — Fareeda Groww', INR: '14586', Amount: '14586', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'BUY', Brokerage: 'Fareeda Groww', SecuritySymbol: 'ESDS SOFTWARE SOLUN', Quantity: '34', UnitPrice: '429', TradeValue: '14586', CostBasis: '14586', CashImpact: '-14586', RealizedPnl: '0' },
  { ID: '78d887a8-a6cb-6ed5-172f-19293c03fa81', Date: '04/09/2026', Account: 'Share Market', FromSubAccount: 'Fareeda Groww', ToSubAccount: 'Fareeda Groww', Note: 'ESDD Software Solun', Description: 'ESDS Software Solutions — Delivery — Market — 34 @ ₹862.40 — Fareeda Groww', INR: '29244.36', Amount: '29244.36', 'Income/Expense': 'Transfer-Out', InvestmentTransactionType: 'SELL', Brokerage: 'Fareeda Groww', SecuritySymbol: 'ESDS SOFTWARE SOLUN', Quantity: '34', UnitPrice: '862.40', TradeValue: '29321.60', CostBasis: '14586', CashImpact: '29244.36', RealizedPnl: '14658.36' }
];

explicitTrades.forEach(tr => {
  const existingIdx = cleanRows.findIndex(r => r.ID === tr.ID);
  if (existingIdx !== -1) {
    cleanRows[existingIdx] = { ...cleanRows[existingIdx], ...tr };
  } else {
    cleanRows.push(tr);
  }
});

// Strict RFC-4180 CSV Serializer
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
const dataRowStrings = cleanRows.map(serializeRow);
const finalCsvContent = '\ufeff' + [headerRowString, ...dataRowStrings].join('\n');

const targetPath = 'finman_2026-09-05.csv';
fs.writeFileSync(targetPath, finalCsvContent, 'utf8');

console.log(`\nSuccessfully re-serialized ${targetPath}!`);
console.log(`Total Logical Records Written: ${cleanRows.length}`);
