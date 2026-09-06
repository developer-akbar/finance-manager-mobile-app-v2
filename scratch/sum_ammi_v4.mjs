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

let ammiTotal = 0;
let fareedaTotal = 0;

v4Rows.forEach(t => {
  const acct = t.Account || t.FromAccount;
  const toAcct = t.ToAccount;
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'];
  if (isNaN(amt) || amt === 0) return;

  const isDestLmf = toAcct === 'Liquid Mutual Funds';
  const isAcctLmf = acct === 'Liquid Mutual Funds';

  if (!isDestLmf && !isAcctLmf) return;

  const sub = resolveInvestmentSubAccount(t, 'Liquid Mutual Funds');

  let delta = 0;
  if (isDestLmf && type === 'Transfer-Out') delta += amt;
  if (isAcctLmf) {
    if (type === 'Income') delta += amt;
    else if (type === 'Expense') delta -= amt;
    else if (type === 'Transfer-Out') delta -= amt;
  }

  if (sub === 'Ammi Groww') ammiTotal += delta;
  if (sub === 'Fareeda Groww') fareedaTotal += delta;
});

console.log('Ammi Total in v4:', ammiTotal);
console.log('Fareeda Total in v4:', fareedaTotal);
