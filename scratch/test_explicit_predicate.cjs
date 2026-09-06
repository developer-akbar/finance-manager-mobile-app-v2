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

function resolveInvestmentPlatform(txn) {
  if (!txn) return null;
  const broker = String(txn.Brokerage || txn.brokerage || txn.SubAccount || txn.sub_account || '').trim();
  if (broker) return broker;
  const src = String(txn.Source || txn.source || '').trim();
  if (src.includes('CAS') || src.includes('CAMS')) return 'Ak ETMoney';
  return null;
}

function resolveInvestmentParent(txn) {
  if (!txn) return null;
  const acct = String(txn.Account || txn.account || '').trim();
  const fromAcct = String(txn.FromAccount || txn.from_account || '').trim();
  const toAcct = String(txn.ToAccount || txn.to_account || '').trim();
  const cat = String(txn.Category || txn.category || '').trim();

  if (toAcct === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver' || fromAcct === 'Mutual Funds Tax Saver' || cat === 'Mutual Funds Tax Saver') {
    return 'Mutual Funds Tax Saver';
  }
  if (toAcct === 'Liquid Mutual Funds' || acct === 'Liquid Mutual Funds' || fromAcct === 'Liquid Mutual Funds' || cat === 'Liquid Mutual Funds') {
    return 'Liquid Mutual Funds';
  }
  if (toAcct === 'Share Market' || acct === 'Share Market' || fromAcct === 'Share Market' || cat === 'Share Market' || cat === 'Equity') {
    return 'Share Market';
  }
  return null;
}

function isInvestmentTransactionForSubAccount(txn, parentAsset, subAccount) {
  if (!txn || !parentAsset || !subAccount) return false;
  const isInv = Boolean(
    txn.InvestmentTransactionType || txn.investment_transaction_type ||
    txn.Brokerage || txn.brokerage ||
    txn.SecurityISIN || txn.security_isin
  );
  if (!isInv) return false;

  const resolvedParent = resolveInvestmentParent(txn);
  if (resolvedParent !== parentAsset) return false;

  const resolvedPlatform = resolveInvestmentPlatform(txn);
  return resolvedPlatform === subAccount;
}

console.log('=== TEST EXPLICIT PREDICATE ON V2 PREVIEW DATASET ===\n');

const taxTxns = allTxns.filter(t => isInvestmentTransactionForSubAccount(t, 'Mutual Funds Tax Saver', 'Ak ETMoney'));
const liqTxns = allTxns.filter(t => isInvestmentTransactionForSubAccount(t, 'Liquid Mutual Funds', 'Ak ETMoney'));

console.log(`Mutual Funds Tax Saver › Ak ETMoney: ${taxTxns.length} txns`);
console.log(`Liquid Mutual Funds › Ak ETMoney:    ${liqTxns.length} txns`);

// Pick DSP Tax Saver example
const dspExample = taxTxns.find(t => t.SecuritySymbol && t.SecuritySymbol.includes('DSP'));
console.log('\nSample Tax Saver Transaction:');
console.log(JSON.stringify(dspExample, null, 2));

// Pick Liquid MF example
const liqExample = liqTxns.find(t => t.SecuritySymbol);
console.log('\nSample Liquid MF Transaction:');
console.log(JSON.stringify(liqExample, null, 2));

