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

console.log('=== AUDITING AMMI GROWW & FAREEDA GROWW IN BASE CSV ===\n');

let ammiCount = 0;
let fareedaCount = 0;
let ammiBal = 0;
let fareedaBal = 0;

baseRows.forEach(r => {
  const sub = String(r.SubAccount || r.ToSubAccount || r.FromSubAccount || '').trim();
  const desc = String(r.Description || r.Note || '').toLowerCase();
  const amt = parseFloat(r.INR || r.Amount || 0);
  const type = r['Income/Expense'];

  if (sub === 'Ammi Groww' || desc.includes('ammi groww')) {
    ammiCount++;
    if (type === 'Transfer-Out') ammiBal += amt;
  }
  if (sub === 'Fareeda Groww' || desc.includes('fareeda groww') || desc.includes('fareeda etmoney')) {
    fareedaCount++;
    if (type === 'Transfer-Out') fareedaBal += amt;
  }
});

console.log(`Base Rows: Total=${baseRows.length}`);
console.log(`Ammi Groww: Rows=${ammiCount}, Liquid MF Inflow=₹${ammiBal.toFixed(2)}`);
console.log(`Fareeda Groww: Rows=${fareedaCount}, Liquid MF Inflow=₹${fareedaBal.toFixed(2)}`);

