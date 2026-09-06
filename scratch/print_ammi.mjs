import fs from 'fs';

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
    const values = [];
    let match;
    while ((match = regex.exec(lines[i])) !== null) {
      if (match.index === regex.lastIndex) regex.lastIndex++;
      values.push(match[1] !== undefined ? match[1] : match[2]);
    }
    const obj = {};
    headers.forEach((h, idx) => obj[h] = (values[idx] || '').trim());
    rows.push(obj);
  }
  return rows;
}

const rows = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4.csv', 'utf8'));
rows.forEach(r => {
  const toAcct = r.ToAccount;
  const fromAcct = r.Account || r.FromAccount;
  if (toAcct === 'Liquid Mutual Funds' || fromAcct === 'Liquid Mutual Funds') {
    const combined = (r.Note + ' ' + r.Description).toLowerCase();
    if (combined.includes('ammi')) {
      console.log(r.Date, 'INR:', r.INR, 'Amount:', r.Amount, 'Type:', r['Income/Expense'], 'From:', r.FromAccount, 'To:', r.ToAccount, 'ToSub:', r.ToSubAccount, 'Note:', r.Note, 'Desc:', r.Description.slice(0, 40));
    }
  }
});
