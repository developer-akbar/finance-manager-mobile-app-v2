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

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const txns = parseCSV(raw);

console.log('=== ALL ROWS UNDER CATEGORY "Equity" ===');
const equityRows = txns.filter(t => (t.Category || '').toLowerCase() === 'equity');
console.log('Total Equity Rows:', equityRows.length);

const bySubcat = {};
equityRows.forEach(r => {
  const sub = r.Subcategory || '(none)';
  if (!bySubcat[sub]) bySubcat[sub] = [];
  bySubcat[sub].push(r);
});

for (const [sub, rList] of Object.entries(bySubcat)) {
  const sum = rList.reduce((acc, r) => acc + parseFloat(r.INR || r.Amount || 0), 0);
  console.log(`\nSubcategory: "${sub}" (Count: ${rList.length}, Total INR: ₹${sum.toFixed(2)})`);
  rList.forEach((r, i) => {
    console.log(`  [${i+1}] ID: ${r.ID} | Date: ${r.Date} | INR: ${r.INR} | Account: ${r.Account} | From: ${r.FromAccount} | To: ${r.ToAccount} | Note: ${r.Note} | Desc: ${r.Description.replace(/\r?\n/g, ' ')}`);
  });
}

console.log('\n==================================================');
console.log('=== AUDIT OF MUTUAL FUNDS TAX SAVER REDEMPTIONS ===');
console.log('==================================================');
const tsTransfers = txns.filter(t => (t.FromAccount || t.Account) === 'Mutual Funds Tax Saver' && t['Income/Expense'] === 'Transfer-Out');
console.log(`Total Tax Saver Redemption Transfers: ${tsTransfers.length}`);
let tsPrincipalSum = 0;
tsTransfers.forEach((t, i) => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  tsPrincipalSum += amt;
  console.log(`  [${i+1}] ID: ${t.ID} | Date: ${t.Date} | Principal INR: ₹${amt} | To: ${t.ToAccount} | Note: ${t.Note} | Desc: ${t.Description.replace(/\r?\n/g, ' ')}`);
});
console.log(`Total Tax Saver Principal Returned: ₹${tsPrincipalSum.toFixed(2)}`);

console.log('\n==================================================');
console.log('=== AUDIT OF LIQUID MUTUAL FUNDS REDEMPTIONS ===');
console.log('==================================================');
const lmfTransfers = txns.filter(t => (t.FromAccount || t.Account) === 'Liquid Mutual Funds' && t['Income/Expense'] === 'Transfer-Out');
console.log(`Total Liquid MF Redemption Transfers: ${lmfTransfers.length}`);
let lmfPayoutSum = 0;
lmfTransfers.forEach((t, i) => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  lmfPayoutSum += amt;
  console.log(`  [${i+1}] ID: ${t.ID} | Date: ${t.Date} | Payout INR: ₹${amt} | Sub: ${t.SubAccount || t.FromSubAccount} | To: ${t.ToAccount} | Note: ${t.Note} | Desc: ${t.Description.replace(/\r?\n/g, ' ')}`);
});
console.log(`Total Liquid MF Payout Returned to Bank: ₹${lmfPayoutSum.toFixed(2)}`);

