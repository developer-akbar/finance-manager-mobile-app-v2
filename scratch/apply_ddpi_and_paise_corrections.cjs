const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split('\n').filter(l => l.trim());
const headerLine = lines[0];
const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));

const rows = lines.slice(1).map(line => {
  const values = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { values.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
    else cur += c;
  }
  values.push(cur.trim().replace(/^"|"$/g, ''));
  const obj = {};
  headers.forEach((h, idx) => { obj[h] = values[idx] || ''; });
  return obj;
});

console.log(`Original CSV rows: ${rows.length}`);

// 1. Update exact paise for the four stock SELL net proceeds
const sellUpdates = {
  '9623c148-9c23-48a6-99bb-3e2b454e67c1': { inr: '2511.70', amount: '2511.70', cashImpact: '2511.70', pnl: '-664.30' },
  '56b665f6-e40a-4cb3-950d-97071a91d861': { inr: '19998.03', amount: '19998.03', cashImpact: '19998.03', pnl: '5124.03' },
  'c2a762ff-ccf5-48e6-b59b-3c42250fcb65': { inr: '20336.34', amount: '20336.34', cashImpact: '20336.34', pnl: '5412.34' },
  'cc0ab0c1-cc10-4f04-8889-6078f6faed3a': { inr: '29244.36', amount: '29244.36', cashImpact: '29244.36', pnl: '14658.36' }
};

let updateCount = 0;
rows.forEach(r => {
  const id = r.ID || r._id;
  if (sellUpdates[id]) {
    const u = sellUpdates[id];
    r.INR = u.inr;
    r.Amount = u.amount;
    r.CashImpact = u.cashImpact;
    r.RealizedPnl = u.pnl;
    updateCount++;
  }
});
console.log(`Updated ${updateCount} stock SELL rows with exact paise figures.`);

// 2. Add DDPI Expense Transaction if not already present
const ddpiExists = rows.some(r => (r.Note || '').includes('DDPI') || (r.Description || '').includes('DDPI'));
let ddpiId = '';

if (!ddpiExists) {
  ddpiId = uuidv4();
  const ddpiRow = {
    Date: '31-08-2026',
    Time: '10:00',
    Account: 'Share Market',
    AccountGroup: 'Investments',
    AccountType: '',
    CardLast4: '',
    SettlementDate: '',
    PaymentDueDays: '',
    AccountOrder: '0',
    AccountGroupOrder: '0',
    FromAccount: 'Share Market',
    FromAccountGroup: 'Investments',
    FromAccountOrder: '0',
    ToAccount: '',
    ToAccountGroup: '',
    ToAccountOrder: '',
    Category: 'Share Market',
    Subcategory: 'Default',
    Note: 'DDPI Charges',
    Description: 'DDPI Charges',
    INR: '118',
    Amount: '118',
    Currency: 'INR',
    'Income/Expense': 'Expense',
    Tags: '',
    recurring_rule_id: '',
    warranty_expiry: '',
    serial_no: '',
    receipt_image: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ID: ddpiId,
    SubAccount: 'Fareeda Groww',
    FromSubAccount: 'Fareeda Groww',
    ToSubAccount: '',
    InvestmentTransactionType: '',
    Brokerage: 'Fareeda Groww',
    SecuritySymbol: '',
    SecurityISIN: '',
    Quantity: '',
    UnitPrice: '',
    TradeValue: '',
    CostBasis: '',
    CashImpact: '-118',
    PositionQuantityChange: '',
    RealizedPnl: '',
    TradeId: '',
    OrderId: '',
    Exchange: '',
    Segment: '',
    Source: 'Groww'
  };
  rows.push(ddpiRow);
  console.log(`Added DDPI charge transaction with ID: ${ddpiId}`);
} else {
  const existingDdpi = rows.find(r => (r.Note || '').includes('DDPI') || (r.Description || '').includes('DDPI'));
  ddpiId = existingDdpi.ID || existingDdpi._id;
  console.log(`DDPI charge transaction already exists with ID: ${ddpiId}`);
}

// Convert rows back to CSV string safely handling fields with commas/quotes
function formatCsvRow(obj) {
  return headers.map(h => {
    let val = String(obj[h] || '');
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      val = '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  }).join(',');
}

const newCsvLines = [headerLine, ...rows.map(formatCsvRow)];
fs.writeFileSync(csvPath, newCsvLines.join('\n'), 'utf8');
console.log(`Successfully updated ${csvPath}! Total rows: ${rows.length}`);
