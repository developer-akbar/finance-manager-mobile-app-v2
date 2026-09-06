const fs = require('fs');

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return rows;
}

const raw = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const initialRows = parseCSV(raw);

function buildAccountBalances(txns) {
  const map = {};
  txns.forEach(t => {
    const type = t['Income/Expense'];
    const acct = t.Account || t.FromAccount || '';
    const dest = t.ToAccount || '';
    const inr = parseFloat(t.INR || t.Amount || 0);

    if (!map[acct]) map[acct] = 0;
    if (dest && !map[dest]) map[dest] = 0;

    if (type === 'Income') {
      map[acct] += inr;
    } else if (type === 'Expense') {
      map[acct] -= inr;
    } else if (type === 'Transfer-Out') {
      map[acct] -= inr;
      if (dest) map[dest] += inr;
    }
  });
  return map;
}

const balancesOriginal = buildAccountBalances(initialRows);

const reconciliationTxn = {
  ID: 'zerodha_opening_cash_recon_pre_tradebook',
  Date: '01/04/2024',
  Time: '00:00:00',
  Account: 'Share Market',
  FromAccount: 'Share Market',
  ToAccount: '',
  Category: 'Finance',
  Subcategory: '',
  Note: 'Historical opening cash reconciliation for pre-tradebook activity',
  Description: 'RECONCILIATION | Broker=Zerodha | Amount=-1953.02 | Reason=Historical opening cash reconciliation for pre-tradebook activity',
  INR: '-1953.02',
  Amount: '-1953.02',
  Currency: 'INR',
  'Income/Expense': 'Expense',
  SubAccount: 'Zerodha',
  FromSubAccount: 'Zerodha',
  ToSubAccount: '',
  InvestmentTransactionType: 'RECONCILIATION',
  Brokerage: 'Zerodha',
  Quantity: '0',
  TradeValue: '0',
  CashImpact: '-1953.02'
};

const balancesWithRecon = buildAccountBalances([...initialRows, reconciliationTxn]);

console.log('=== REGRESSION TEST: NON-BROKERAGE ACCOUNT BALANCES ===');
const checkAccounts = ['HDFC', 'Canara', 'SBI', 'Liquid Mutual Funds', 'Mutual Funds Tax Saver', 'PPF', 'SSY'];
checkAccounts.forEach(acct => {
  const orig = (balancesOriginal[acct] || 0).toFixed(2);
  const withRec = (balancesWithRecon[acct] || 0).toFixed(2);
  const match = orig === withRec;
  console.log(`${acct.padEnd(25)}: Original = ₹${orig}, With Recon = ₹${withRec} -> ${match ? 'MATCH (100% UNCHANGED)' : 'MISMATCH'}`);
});

