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

function isInvestmentPortfolioTxn(t) {
  if (!t) return false;
  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim();
  const broker = String(t.Brokerage || t.brokerage || '').trim();
  const isin = String(t.SecurityISIN || t.security_isin || '').trim();
  const sym = String(t.SecuritySymbol || t.security_symbol || '').trim();
  const src = String(t.Source || t.source || '').trim();

  // 1. Explicit investment transaction fields
  if (invType || broker || isin || sym || src.includes('CAS') || src.includes('CAMS')) {
    return true;
  }

  const acct = String(t.Account || t.FromAccount || '').trim();
  const dest = String(t.ToAccount || '').trim();
  const isInvAcc = isInvestmentAccount(acct) || isInvestmentAccount(dest);
  const cat = String(t.Category || '').toLowerCase();
  const note = String(t.Note || '').toLowerCase();
  const desc = String(t.Description || '').toLowerCase();
  const combined = `${note} ${desc}`;

  // 2. Stock profits, dividends, investment returns
  if (cat === 'equity' || cat === 'investment returns' || note.includes('dividend') || note.includes('profit') || note.includes('loss')) {
    return true;
  }

  // 3. Known platform valuation transfers (Fareeda Groww, Ammi Groww, Scripbox)
  if (isInvAcc) {
    if (
      combined.includes('groww') || 
      combined.includes('fareeda') || 
      combined.includes('ammi') || 
      combined.includes('scripbox') || 
      combined.includes('zerodha') ||
      combined.includes('etmoney') ||
      combined.includes('tax saver') ||
      combined.includes('tax advantage')
    ) {
      return true;
    }
  }

  // Pure bank cash movements (e.g. Liquid Mutual Funds -> HDFC "transferred") are NOT investment portfolio transactions
  return false;
}

function resolveInvestmentParent(t) {
  const acct = String(t.Account || t.FromAccount || '').trim();
  const dest = String(t.ToAccount || '').trim();
  
  if (isInvestmentAccount(dest)) return dest;
  if (isInvestmentAccount(acct)) return acct;

  const cat = String(t.Category || '').toLowerCase();
  const note = String(t.Note || '').toLowerCase();
  const desc = String(t.Description || '').toLowerCase();
  const combined = `${note} ${desc} ${cat}`;

  if (combined.includes('tax saver') || combined.includes('tax advantage')) return 'Mutual Funds Tax Saver';
  if (combined.includes('liquid') || combined.includes('lmf') || combined.includes('mutual fund') || combined.includes('mf')) return 'Liquid Mutual Funds';
  if (combined.includes('share market') || combined.includes('zerodha') || combined.includes('dividend') || cat === 'equity') return 'Share Market';

  return null;
}

function resolveInvestmentPlatform(t, parentAsset) {
  const broker = String(t.Brokerage || t.brokerage || '').trim();
  if (broker) return broker;

  const src = String(t.Source || t.source || '').trim();
  if (src.includes('CAS') || src.includes('CAMS')) return 'Ak ETMoney';

  const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
  if (sub && sub !== 'Default') return sub;

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
    if (t.InvestmentTransactionType || t.SecurityISIN) return 'Ak ETMoney';
  }
  return null;
}

function resolveInvestmentGroupKey(t) {
  if (!isInvestmentPortfolioTxn(t)) return null;
  const parent = resolveInvestmentParent(t);
  if (!parent) return null;
  const platform = resolveInvestmentPlatform(t, parent);
  if (!platform) return null;
  return `${parent} > ${platform}`;
}

console.log('=== TEST AUTHORITATIVE PORTFOLIO GROUPING PIPELINE ===\n');

// 1. Test Specific Non-Investment Cash Movements
const cashXfer1 = { FromAccount: 'Liquid Mutual Funds', ToAccount: 'HDFC', Note: 'transferred', Amount: '34000', 'Income/Expense': 'Transfer-Out' };
const cashXfer2 = { FromAccount: 'HDFC', ToAccount: 'Liquid Mutual Funds', Note: 'bank deposit', Amount: '10000', 'Income/Expense': 'Transfer-Out' };

console.log('1. Cash Movements Check:');
console.log(`  Liquid MF -> HDFC ("transferred"): isInvestment = ${isInvestmentPortfolioTxn(cashXfer1)} | GroupKey = ${resolveInvestmentGroupKey(cashXfer1)} ${!isInvestmentPortfolioTxn(cashXfer1) ? '✅ EXCLUDED' : '❌'}`);
console.log(`  HDFC -> Liquid MF ("deposit"):     isInvestment = ${isInvestmentPortfolioTxn(cashXfer2)} | GroupKey = ${resolveInvestmentGroupKey(cashXfer2)} ${!isInvestmentPortfolioTxn(cashXfer2) ? '✅ EXCLUDED' : '❌'}`);

// 2. Test Specific CAS Records
const casBuy = { FromAccount: 'Liquid Mutual Funds', ToAccount: 'Liquid Mutual Funds', InvestmentTransactionType: 'BUY', Brokerage: 'Ak ETMoney', Source: 'CAMS_CAS', SecuritySymbol: 'FTI485-Franklin India' };
const casSell = { FromAccount: 'Liquid Mutual Funds', ToAccount: 'Liquid Mutual Funds', InvestmentTransactionType: 'SELL', Brokerage: 'Ak ETMoney', Source: 'CAMS_CAS', SecuritySymbol: 'FTI485-Franklin India' };
const casAdj = { FromAccount: 'Liquid Mutual Funds', ToAccount: 'Liquid Mutual Funds', InvestmentTransactionType: 'UNIT_ADJUSTMENT', Brokerage: 'Ak ETMoney', Source: 'CAMS_CAS', SecuritySymbol: 'FTI485-Franklin India' };

console.log('\n2. CAS Records Check:');
console.log(`  CAS BUY:  GroupKey = ${resolveInvestmentGroupKey(casBuy)} ${resolveInvestmentGroupKey(casBuy) === 'Liquid Mutual Funds > Ak ETMoney' ? '✅' : '❌'}`);
console.log(`  CAS SELL: GroupKey = ${resolveInvestmentGroupKey(casSell)} ${resolveInvestmentGroupKey(casSell) === 'Liquid Mutual Funds > Ak ETMoney' ? '✅' : '❌'}`);
console.log(`  CAS ADJ:  GroupKey = ${resolveInvestmentGroupKey(casAdj)} ${resolveInvestmentGroupKey(casAdj) === 'Liquid Mutual Funds > Ak ETMoney' ? '✅' : '❌'}`);

// 3. Test Full Dataset Grouping
const groups = {};
for (const t of allTxns) {
  const gKey = resolveInvestmentGroupKey(t);
  if (!gKey) continue;
  if (!groups[gKey]) groups[gKey] = [];
  groups[gKey].push(t);
}

console.log('\n3. Full Dataset Resulting Groups & Transaction Counts:');
for (const [gKey, txns] of Object.entries(groups)) {
  const casCount = txns.filter(t => t.Source === 'CAMS_CAS').length;
  console.log(`  ${gKey.padEnd(35)}: ${String(txns.length).padStart(4)} txns (CAS: ${casCount})`);
}

// 4. Verify Bank Accounts Group Count
const bankGroups = Object.keys(groups).filter(g => g.startsWith('HDFC') || g.startsWith('SBI') || g.startsWith('ICICI') || g.startsWith('Amazon'));
console.log('\n4. Bank Groups in Portfolio:', bankGroups.length, bankGroups.length === 0 ? '✅ EXACT 0 BANK GROUPS' : '❌ DETECTED BANK GROUPS');

