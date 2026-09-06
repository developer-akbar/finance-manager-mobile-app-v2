import fs from 'fs';
import { resolveInvestmentSubAccount } from '../src/utils/brokerageAccounting.js';

function parseCSV(text) {
  if (!text || !text.trim()) return [];
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
    if (values.length > headers.length) values.length = headers.length;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (values[idx] || '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

const v4Rows = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4.csv', 'utf8'));

v4Rows.forEach(t => {
  const acct = t.Account || t.FromAccount;
  const toAcct = t.ToAccount;
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'];
  if (isNaN(amt) || amt === 0) return;

  const desc = (t.Description || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();
  const sub = t.SubAccount || t.FromSubAccount || '';
  const toSub = t.ToSubAccount || '';

  let delta = 0;
  if (toAcct === 'Liquid Mutual Funds' && type === 'Transfer-Out') delta += amt;
  if (acct === 'Liquid Mutual Funds') {
    if (type === 'Income') delta += amt;
    else if (type === 'Expense') delta -= amt;
    else if (type === 'Transfer-Out') delta -= amt;
  }

  if (delta !== 0) {
    const isAmmiInFlowScript = sub.includes('Ammi') || toSub.includes('Ammi') || desc.includes('ammi') || note.includes('ammi');
    const resolvedByFunction = resolveInvestmentSubAccount(t, 'Liquid Mutual Funds');

    if (isAmmiInFlowScript && resolvedByFunction !== 'Ammi Groww') {
      console.log(`MISMATCH: ID=${t.ID} Date=${t.Date} INR=${amt} Note="${t.Note}" Desc="${t.Description}" sub="${sub}" toSub="${toSub}" Resolved="${resolvedByFunction}"`);
    }
  }
});
