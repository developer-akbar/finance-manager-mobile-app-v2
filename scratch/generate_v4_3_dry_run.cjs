const fs = require('fs');
const crypto = require('crypto');

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

function stringifyCSV(headers, rows) {
  const escapeField = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.map(escapeField).join(',')];
  for (const r of rows) {
    const rowFields = headers.map(h => escapeField(r[h] || ''));
    lines.push(rowFields.join(','));
  }
  return lines.join('\n');
}

const v4_2 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4_2.csv', 'utf8'));

console.log('=== GENERATE V4.3 DRY-RUN (PRECISION NOTE CLEANUP) ===\n');

function cleanNote(r) {
  const orig = (r.Note || '').trim();
  const desc = (r.Description || '').trim();

  // 1. CAMS_CAS Raw Technical Scheme Codes
  if (orig.startsWith('127LTGPG-') || orig === 'Motilal Oswal Asset Management') return 'Motilal Oswal ELSS';
  if (orig.startsWith('117TSRGG-')) return 'Mirae Asset ELSS';
  if (orig.startsWith('D110-') || orig === 'DSP Tax Saver') return 'DSP ELSS';
  if (orig.startsWith('101ETGPG-') || orig === 'Canara Robeco Equity') return 'Canara Robeco ELSS';
  if (orig.startsWith('OFTAFG-') || orig === 'L&T Tax Advantage') return 'HSBC ELSS';
  if (orig.startsWith('FTI485-')) return 'Franklin India Ultra Short Bond';
  if (orig.startsWith('K494D-')) return 'Kotak Nifty Next 50';
  if (orig.startsWith('RMFLFAGG-')) return 'Nippon India Liquid Fund';
  if (orig.startsWith('RMFNPAGG-')) return 'Nippon India Nifty Midcap 150';
  if (orig === 'Quant Tax') return 'Quant ELSS';

  // 2. Groww & Clean Scheme Names
  if (orig === 'Mirae Asset Large & Midcap') return 'Mirae Large & Midcap';

  return orig;
}

let notesChanged = 0;
let descsChanged = 0;
const examples = [];

const v4_3Rows = v4_2.rows.map((r, idx) => {
  const row = { ...r };
  const origNote = r.Note;
  const newNote = cleanNote(r);

  if (newNote !== origNote) {
    row.Note = newNote;
    notesChanged++;
    if (examples.length < 15) {
      examples.push({
        rowNum: idx + 1,
        id: row.ID,
        account: row.Account || row.FromAccount,
        origNote,
        newNote,
        desc: row.Description.substring(0, 60)
      });
    }
  }

  return row;
});

const v4_3Content = stringifyCSV(v4_2.headers, v4_3Rows);
const targetPath = 'scratch/finman_reconstructed_master_preview_v4_3.csv';
fs.writeFileSync(targetPath, v4_3Content, 'utf8');

const v4_3Sha = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
const stat = fs.statSync(targetPath);

console.log(`Successfully generated dry-run preview V4.3: ${targetPath}`);
console.log(`- Total Rows: ${v4_3Rows.length} data rows (${v4_3Rows.length + 1} lines with header)`);
console.log(`- File Size: ${stat.size} bytes`);
console.log(`- SHA-256 Checksum: ${v4_3Sha}`);
console.log(`- Notes Changed: ${notesChanged}`);
console.log(`- Descriptions Changed: ${descsChanged}`);

console.log('\n--- REPRESENTATIVE BEFORE/AFTER EXAMPLES ---');
examples.forEach(ex => {
  console.log(`[Row ${ex.rowNum} | ID: ${ex.id.substring(0, 10)}... | Acct: ${ex.account}]`);
  console.log(`  Before: "${ex.origNote}"`);
  console.log(`  After:  "${ex.newNote}"\n`);
});

