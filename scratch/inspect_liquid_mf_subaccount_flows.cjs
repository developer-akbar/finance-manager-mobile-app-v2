const fs = require('fs');

function parseCSV(text) {
  if (!text || !text.trim()) return { headers: [], rows: [] };
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

  if (records.length < 2) return { headers: [], rows: [] };
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
  return { headers, rows };
}

const v4 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4.csv', 'utf8'));

let fareedaLiquidSum = 0;
let ammiLiquidSum = 0;
let akLiquidSum = 0;
let otherLiquidSum = 0;

v4.rows.forEach(t => {
  const acct = t.Account || t.FromAccount;
  const toAcct = t.ToAccount;
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'];
  if (isNaN(amt) || amt === 0) return;

  const desc = (t.Description || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();
  const sub = t.SubAccount || t.FromSubAccount || '';
  const toSub = t.ToSubAccount || '';

  // Calculate flow into Liquid Mutual Funds
  let delta = 0;
  if (toAcct === 'Liquid Mutual Funds' && type === 'Transfer-Out') delta += amt;
  if (acct === 'Liquid Mutual Funds') {
    if (type === 'Income') delta += amt;
    else if (type === 'Expense') delta -= amt;
    else if (type === 'Transfer-Out') delta -= amt;
  }

  if (delta !== 0) {
    if (sub.includes('Fareeda') || toSub.includes('Fareeda') || desc.includes('fareeda') || note.includes('fareeda')) {
      fareedaLiquidSum += delta;
    } else if (sub.includes('Ammi') || toSub.includes('Ammi') || desc.includes('ammi') || note.includes('ammi')) {
      ammiLiquidSum += delta;
    } else if (t.Source === 'CAMS_CAS') {
      akLiquidSum += delta;
    } else {
      otherLiquidSum += delta;
      console.log(`Other Liquid MF flow: Row ${t.ID} | ${t.Date} | ₹${amt} | ${type} | ${t.Note} | ${t.Description}`);
    }
  }
});

console.log(`Fareeda Liquid MF Sum: ₹${fareedaLiquidSum}`);
console.log(`Ammi Liquid MF Sum: ₹${ammiLiquidSum}`);
console.log(`Ak ETMoney Liquid MF Sum: ₹${akLiquidSum}`);
console.log(`Other Liquid MF Sum: ₹${otherLiquidSum}`);
console.log(`Total Liquid MF: ₹${fareedaLiquidSum + ammiLiquidSum + akLiquidSum + otherLiquidSum}`);

