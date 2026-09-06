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

const previewRaw = fs.readFileSync('scratch/finman_CAS_enriched_master_preview_v2.csv', 'utf8');
const allTxns = parseCSV(previewRaw);

console.log('=== COMPREHENSIVE HISTORICAL INVESTMENT ADJUSTMENT AUDIT ===\n');

// 1. Calculate and record the CURRENT IMMUTABLE BASELINE BALANCES
const balances = {};
const subBalances = {};

allTxns.forEach(t => {
  const type = t['Income/Expense'];
  const amt = parseFloat(t.INR || t.Amount || 0);
  if (isNaN(amt) || amt === 0) return;

  const acct = t.Account || t.FromAccount;
  const toAcct = t.ToAccount;
  const sub = t.SubAccount || t.FromSubAccount;
  const toSub = t.ToSubAccount;

  if (type === 'Income') {
    if (acct) balances[acct] = (balances[acct] || 0) + amt;
    if (acct && sub) {
      const k = `${acct} › ${sub}`;
      subBalances[k] = (subBalances[k] || 0) + amt;
    }
  } else if (type === 'Expense') {
    if (acct) balances[acct] = (balances[acct] || 0) - amt;
    if (acct && sub) {
      const k = `${acct} › ${sub}`;
      subBalances[k] = (subBalances[k] || 0) - amt;
    }
  } else if (type === 'Transfer-Out') {
    if (acct) balances[acct] = (balances[acct] || 0) - amt;
    if (toAcct) balances[toAcct] = (balances[toAcct] || 0) + amt;

    if (acct && sub) {
      const k = `${acct} › ${sub}`;
      subBalances[k] = (subBalances[k] || 0) - amt;
    }
    if (toAcct && toSub) {
      const k = `${toAcct} › ${toSub}`;
      subBalances[k] = (subBalances[k] || 0) + amt;
    }
  }
});

console.log('--- 1. CURRENT IMMUTABLE BASELINE BALANCES ---');
for (const [acct, bal] of Object.entries(balances)) {
  console.log(`${acct.padEnd(25)}: ₹${bal.toFixed(2)}`);
}
console.log('\n--- Key Subaccount Balances ---');
for (const [sub, bal] of Object.entries(subBalances)) {
  if (sub.includes('Groww') || sub.includes('Ak ETMoney') || sub.includes('Zerodha') || sub.includes('My Amazon')) {
    console.log(`${sub.padEnd(35)}: ₹${bal.toFixed(2)}`);
  }
}

// 2. Comprehensive Search for all suspicious keywords across entire history
const keywords = [
  'from share market', 'market loss', 'general loss', 'loss', 'useless',
  'profit on muvar', 'adjusted from', 'adjusting balance', 'adjusted balance',
  'adjusting unknown', 'ftmf loss', 'ftmf profit', 'from franklin', 'franklin short bond',
  'recovered from', 'recovery', 'balancing'
];

const suspiciousList = [];

allTxns.forEach((t, idx) => {
  const rowNum = idx + 1;
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Category} ${t.Subcategory} ${t.Note} ${t.Description} ${t.Tags}`.toLowerCase();
  
  // Exclude normal CAS records which are already structured
  if (t.Source === 'CAMS_CAS' && t.InvestmentTransactionType) return;
  // Exclude structured Zerodha tradebook BUY/SELL lines that have explicit Symbol/Qty
  if (t.Source === 'Zerodha' && t.InvestmentTransactionType) return;

  for (const kw of keywords) {
    if (c.includes(kw)) {
      suspiciousList.push({
        row: rowNum,
        matched: kw,
        date: t.Date,
        type: t['Income/Expense'],
        amount: parseFloat(t.INR || t.Amount || 0),
        from: t.Account || t.FromAccount,
        to: t.ToAccount,
        sub: t.SubAccount || t.FromSubAccount,
        toSub: t.ToSubAccount,
        cat: t.Category,
        subcat: t.Subcategory,
        note: t.Note,
        desc: t.Description
      });
      break;
    }
  }
});

console.log(`\n--- 2. TOTAL SUSPICIOUS RECORDS IDENTIFIED: ${suspiciousList.length} ---`);

// 3. Group by distinct historical phenomena
const group10k = suspiciousList.filter(t => {
  return t.row === 25130 || t.row === 25170 || t.row === 25171 || t.row === 25172 || t.row === 25187 || t.row === 25321 || t.row === 25588;
});

const groupFtmf2020 = suspiciousList.filter(t => {
  const c = `${t.note} ${t.desc}`.toLowerCase();
  return (c.includes('ftmf') || c.includes('franklin')) && (t.date.includes('2020') || t.date.includes('2021'));
});

const groupUselessOrGeneralLoss = suspiciousList.filter(t => {
  const c = `${t.cat} ${t.subcat} ${t.note} ${t.desc}`.toLowerCase();
  return c.includes('general loss') || c.includes('market loss') || c.includes('useless') || t.cat === 'Useless';
});

const groupZerodhaIncomeLosses = suspiciousList.filter(t => {
  const c = `${t.note} ${t.desc} ${t.subcat}`.toLowerCase();
  return c.includes('zerodha losses') || (c.includes('realized loss on sale') && t.from === 'Share Market');
});

const groupZerodhaIncomeGains = suspiciousList.filter(t => {
  const c = `${t.note} ${t.desc} ${t.subcat}`.toLowerCase();
  return c.includes('zerodha gains') || (c.includes('realized profit on sale') && t.from === 'Share Market');
});

console.log(`- Group 1: 2018 Share Market ₹10,000 Balancing Cluster : ${group10k.length} txns (₹${group10k.reduce((acc, t) => acc + t.amount, 0).toFixed(2)})`);
console.log(`- Group 2: 2020 FTMF / Franklin Manual Balancing Cluster : ${groupFtmf2020.length} txns (₹${groupFtmf2020.reduce((acc, t) => acc + t.amount, 0).toFixed(2)})`);
console.log(`- Group 3: "General Loss", "Market Loss", "Useless" Entries: ${groupUselessOrGeneralLoss.length} txns (₹${groupUselessOrGeneralLoss.reduce((acc, t) => acc + t.amount, 0).toFixed(2)})`);
console.log(`- Group 4: 2018 Zerodha Realized Loss Income Records       : ${groupZerodhaIncomeLosses.length} txns (₹${groupZerodhaIncomeLosses.reduce((acc, t) => acc + t.amount, 0).toFixed(2)})`);
console.log(`- Group 5: 2018 Zerodha Realized Gain Income Records       : ${groupZerodhaIncomeGains.length} txns (₹${groupZerodhaIncomeGains.reduce((acc, t) => acc + t.amount, 0).toFixed(2)})`);

// Print details of Group 1
console.log('\n--- GROUP 1: 2018 SHARE MARKET / LEND ₹10,000 CLUSTER DETAILS ---');
group10k.forEach(t => {
  console.log(`[Row ${t.row}] ${t.date} | ₹${t.amount.toFixed(2).padStart(8)} | From: ${t.from} -> To: ${t.to} | Note: "${t.note}" | Desc: "${t.desc}"`);
});

// Print details of Group 2
console.log('\n--- GROUP 2: 2020 FTMF / FRANKLIN MANUAL BALANCING CLUSTER DETAILS ---');
groupFtmf2020.forEach(t => {
  console.log(`[Row ${t.row}] ${t.date} | ₹${t.amount.toFixed(2).padStart(8)} | From: ${t.from} -> To: ${t.to} | Note: "${t.note}" | Desc: "${t.desc}"`);
});

// Print details of Group 3
console.log('\n--- GROUP 3: "GENERAL LOSS" / "MARKET LOSS" / "USELESS" DETAILS ---');
groupUselessOrGeneralLoss.forEach(t => {
  console.log(`[Row ${t.row}] ${t.date} | ₹${t.amount.toFixed(2).padStart(8)} | From: ${t.from} -> To: ${t.to} | Cat: ${t.cat} | SubCat: ${t.subcat} | Note: "${t.note}" | Desc: "${t.desc}"`);
});

