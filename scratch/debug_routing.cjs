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

const enrichedRaw = fs.readFileSync('scratch/finman_CAS_enriched_master_preview_v2.csv', 'utf8');
const enrichedRows = parseCSV(enrichedRaw);
const casRowsEnriched = enrichedRows.filter(r => r.Source === 'CAMS_CAS');

casRowsEnriched.forEach((r, idx) => {
  const isin = r.SecurityISIN;
  const isTax = ['INF760K01100', 'INF760K01EL8', 'INF740K01185', 'INF740K01OK1', 'INF677K01064', 'INF769K01DK3', 'INF769K01DM9', 'INF247L01544', 'INF247L01569', 'INF966L01986'].includes(isin);
  const expectedParent = isTax ? 'Mutual Funds Tax Saver' : 'Liquid Mutual Funds';
  const actualParent = r.ToAccount || r.FromAccount || r.Category;
  const sub = r.ToSubAccount || r.FromSubAccount || r.SubAccount;

  if (actualParent !== expectedParent || sub !== 'Ak ETMoney') {
    console.log(`[Mismatch #${idx+1}] ID=${r.ID} | Expected=${expectedParent} | ActualParent=${actualParent} | From=${r.FromAccount} | To=${r.ToAccount} | Sub=${sub} | FromSub=${r.FromSubAccount} | ToSub=${r.ToSubAccount}`);
  }
});

