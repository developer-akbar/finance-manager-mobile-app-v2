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

const investmentAccounts = [
  { name: 'Mutual Funds Tax Saver', group: 'Investments', subAccounts: [{ name: 'Ak ETMoney' }] },
  { name: 'Liquid Mutual Funds', group: 'Investments', subAccounts: [{ name: 'Fareeda Groww' }, { name: 'Ammi Groww' }, { name: 'Ak ETMoney' }] },
  { name: 'Share Market', group: 'Investments', subAccounts: [{ name: 'Zerodha' }, { name: 'Fareeda Groww' }] }
];

const isInvestmentAccount = (name) => {
  if (!name) return false;
  return investmentAccounts.some(a => a.name.toLowerCase() === name.toLowerCase());
};

const getAssociatedInvestmentAsset = (t) => {
  const acct = String(t.Account || t.FromAccount || '').trim();
  const dest = String(t.ToAccount || '').trim();
  const acctLower = acct.toLowerCase();
  const destLower = dest.toLowerCase();
  
  const ia = investmentAccounts.find(a => a.name.toLowerCase() === acctLower);
  if (ia) return ia.name;
  const idest = investmentAccounts.find(a => a.name.toLowerCase() === destLower);
  if (idest) return idest.name;

  const note = String(t.Note || '').toLowerCase();
  const desc = String(t.Description || '').toLowerCase();
  const cat = String(t.Category || '').toLowerCase();
  const combined = `${note} ${desc} ${cat}`;

  if (combined.includes('tax saver') || combined.includes('tax advantage')) {
    return 'Mutual Funds Tax Saver';
  }
  if (combined.includes('liquid') || combined.includes('lmf') || combined.includes('mutual fund') || combined.includes('mf')) {
    return 'Liquid Mutual Funds';
  }
  if (combined.includes('share market') || combined.includes('zerodha') || combined.includes('dividend') || cat === 'equity') {
    return 'Share Market';
  }
  return null;
};

const getAssociatedSubAccount = (t, parentAsset) => {
  // 1. Authoritative explicit platform/brokerage metadata
  const broker = String(t.Brokerage || t.brokerage || '').trim();
  if (broker) return broker;

  const src = String(t.Source || t.source || '').trim();
  if (src.includes('CAS') || src.includes('CAMS')) {
    return 'Ak ETMoney';
  }

  const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
  if (sub) return sub;

  const note = String(t.Note || '').toLowerCase();
  const desc = String(t.Description || '').toLowerCase();
  const combined = `${note} ${desc}`;

  if (parentAsset === 'Share Market') {
    if (combined.includes('groww') || combined.includes('fareeda')) return 'Fareeda Groww';
    return 'Zerodha';
  }
  if (parentAsset === 'Mutual Funds Tax Saver') {
    return 'Ak ETMoney';
  }
  if (parentAsset === 'Liquid Mutual Funds') {
    if (combined.includes('ammi grow') || combined.includes('ammi')) return 'Ammi Groww';
    if (combined.includes('fareeda') && combined.includes('groww')) return 'Fareeda Groww';
    if (combined.includes('fareeda') && combined.includes('etmoney')) return 'Fareeda ETMoney';
    if (combined.includes('scripbox')) return 'Scripbox';
    if (combined.includes('groww')) return 'Groww';
    return 'Ak ETMoney';
  }
  return null;
};

const getAssetKeyForTxn = (parentName, subName) => {
  if (!parentName) return null;
  const a = investmentAccounts.find(acc => acc.name.toLowerCase() === parentName.toLowerCase());
  const parentTitle = a ? a.name : parentName;
  if (subName) {
    return `${parentTitle} > ${subName}`;
  }
  return parentTitle;
};

console.log('=== TEST PORTFOLIO GROUPING LOGIC ===\n');

const groups = {};
for (const t of allTxns) {
  const acct = String(t.Account || t.FromAccount || '').trim();
  const dest = String(t.ToAccount || '').trim();
  const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || '').trim();
  const destSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

  const isDestInv = isInvestmentAccount(dest);
  const isAcctInv = isInvestmentAccount(acct);
  if (!isDestInv && !isAcctInv) continue;

  const resolvedSub = sub || (isAcctInv ? getAssociatedSubAccount(t, acct) : '');
  const resolvedDestSub = destSub || (isDestInv ? getAssociatedSubAccount(t, dest) : '');

  const acctKey = isAcctInv ? getAssetKeyForTxn(acct, resolvedSub) : null;
  const destKey = isDestInv ? getAssetKeyForTxn(dest, resolvedDestSub) : null;

  const groupKey = destKey || acctKey;
  if (!groups[groupKey]) groups[groupKey] = [];
  groups[groupKey].push(t);
}

console.log('Resulting Portfolio Groups & Transaction Counts:');
for (const [gKey, txns] of Object.entries(groups)) {
  const casCount = txns.filter(t => t.Source === 'CAMS_CAS').length;
  console.log(`  ${gKey.padEnd(35)}: ${String(txns.length).padStart(4)} txns (CAS txns: ${casCount})`);
}

