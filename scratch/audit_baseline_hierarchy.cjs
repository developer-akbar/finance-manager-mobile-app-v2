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

const baseRaw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const baseRows = parseCSV(baseRaw);

console.log('=== BASELINE ACCOUNT & SUBACCOUNT HIERARCHY AUDIT ===\n');

function computeHierarchyAndBalances(rows) {
  const acctBal = {};
  const subBal = {};

  rows.forEach(r => {
    const amt = parseFloat(r.INR || r.Amount || 0);
    const type = String(r['Income/Expense'] || '').trim();
    const acct = String(r.Account || r.FromAccount || '').trim();
    const toAcct = String(r.ToAccount || '').trim();

    const sub = String(r.SubAccount || '').trim();
    const fromSub = String(r.FromSubAccount || r.sub_account || '').trim();
    const toSub = String(r.ToSubAccount || '').trim();

    if (type === 'Income') {
      if (acct) {
        acctBal[acct] = (acctBal[acct] || 0) + amt;
        if (sub) {
          if (!subBal[acct]) subBal[acct] = {};
          subBal[acct][sub] = (subBal[acct][sub] || 0) + amt;
        }
      }
    } else if (type === 'Expense') {
      if (acct) {
        acctBal[acct] = (acctBal[acct] || 0) - amt;
        if (sub) {
          if (!subBal[acct]) subBal[acct] = {};
          subBal[acct][sub] = (subBal[acct][sub] || 0) - amt;
        }
      }
    } else if (type === 'Transfer-Out') {
      if (acct) {
        acctBal[acct] = (acctBal[acct] || 0) - amt;
        if (fromSub) {
          if (!subBal[acct]) subBal[acct] = {};
          subBal[acct][fromSub] = (subBal[acct][fromSub] || 0) - amt;
        }
      }
      if (toAcct) {
        acctBal[toAcct] = (acctBal[toAcct] || 0) + amt;
        if (toSub) {
          if (!subBal[toAcct]) subBal[toAcct] = {};
          subBal[toAcct][toSub] = (subBal[toAcct][toSub] || 0) + amt;
        }
      }
    }
  });

  return { acctBal, subBal };
}

const baseStats = computeHierarchyAndBalances(baseRows);

console.log('--- BASELINE ACCOUNT BALANCES ---');
for (const [acct, bal] of Object.entries(baseStats.acctBal)) {
  console.log(`${acct.padEnd(25)}: ₹${bal.toFixed(2)}`);
  if (baseStats.subBal[acct]) {
    for (const [sub, sBal] of Object.entries(baseStats.subBal[acct])) {
      console.log(`  └── ${sub.padEnd(21)}: ₹${sBal.toFixed(2)}`);
    }
  }
}

