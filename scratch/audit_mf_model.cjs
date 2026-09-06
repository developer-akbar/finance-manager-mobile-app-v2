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

console.log('Total transactions in CSV:', txns.length);

const mfTxns = txns.filter(t => {
  const acct = (t.Account || t.FromAccount || '').toLowerCase();
  const toAcct = (t.ToAccount || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();

  return acct.includes('mutual fund') || acct.includes('liquid') ||
         toAcct.includes('mutual fund') || toAcct.includes('liquid') ||
         desc.includes('tax saver') || desc.includes('scripbox') || desc.includes('groww') || desc.includes('etmoney') ||
         note.includes('liquid mutual') || note.includes('mutual funds tax saver');
});

console.log('Total MF-related transactions found:', mfTxns.length);

// Categorize by account
const taxSaverTxns = mfTxns.filter(t => (t.Account || t.FromAccount || t.ToAccount || '').includes('Mutual Funds Tax Saver') || (t.Note || '').includes('Mutual Funds Tax Saver'));
const liquidMFTxns = mfTxns.filter(t => (t.Account || t.FromAccount || t.ToAccount || '').includes('Liquid Mutual Funds') || (t.Note || '').includes('Liquid Mutual Funds'));

console.log('Tax Saver transactions:', taxSaverTxns.length);
console.log('Liquid MF transactions:', liquidMFTxns.length);

console.log('\n--- SAMPLE TAX SAVER TRANSACTIONS ---');
taxSaverTxns.slice(0, 15).forEach(t => {
  console.log(`[${t.Date}] Type=${t['Income/Expense'].padEnd(12)} | From=${(t.FromAccount||t.Account).padEnd(22)} | To=${(t.ToAccount||'').padEnd(10)} | INR=${String(t.INR).padStart(8)} | Cat=${(t.Category||'').padEnd(12)} | Note=${(t.Note||'').padEnd(25)} | Desc=${(t.Description||'').replace(/\n/g, ' ')}`);
});

console.log('\n--- SAMPLE LIQUID MF TRANSACTIONS ---');
liquidMFTxns.slice(0, 15).forEach(t => {
  console.log(`[${t.Date}] Type=${t['Income/Expense'].padEnd(12)} | From=${(t.FromAccount||t.Account).padEnd(22)} | Sub=${(t.SubAccount||t.FromSubAccount||'').padEnd(14)} | To=${(t.ToAccount||'').padEnd(10)} | INR=${String(t.INR).padStart(8)} | Cat=${(t.Category||'').padEnd(12)} | Note=${(t.Note||'').padEnd(25)} | Desc=${(t.Description||'').replace(/\n/g, ' ')}`);
});

// Check for Redemption and Profit pairs
console.log('\n--- REDEMPTIONS AUDIT ---');
const redemptions = mfTxns.filter(t => (t.Note || '').toLowerCase().includes('redemption') || (t.Description || '').toLowerCase().includes('redemption') || (t.Note || '').toLowerCase().includes('profit') || (t.Note || '').toLowerCase().includes('loss'));
redemptions.forEach(t => {
  console.log(`[${t.Date}] Type=${t['Income/Expense'].padEnd(12)} | Acct=${(t.Account||t.FromAccount).padEnd(22)} | Sub=${(t.SubAccount||t.FromSubAccount||'').padEnd(14)} | To=${(t.ToAccount||'').padEnd(10)} | INR=${String(t.INR).padStart(10)} | Cat=${(t.Category||'').padEnd(25)} | Note=${(t.Note||'').padEnd(35)} | Desc=${(t.Description||'').replace(/\n/g, ' ')}`);
});

