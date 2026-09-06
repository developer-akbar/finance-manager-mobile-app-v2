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

console.log('=== TESTING AccountDetail FILTERING FOR INVESTMENT SUBACCOUNTS ===\n');

function filterAcctTxns(acctName, subAccountName) {
  return allTxns.filter(t => {
    const acct = t.Account || t.FromAccount || '';
    const dest = t.ToAccount || '';
    const sub = t.SubAccount || t.sub_account || '';
    const fromSub = t.FromSubAccount || t.from_sub_account || t.SubAccount || t.sub_account || '';
    const toSub = t.ToSubAccount || t.to_sub_account || '';

    if (subAccountName) {
      const isMFInvestmentSubAccount = (acctName === 'Mutual Funds Tax Saver' || acctName === 'Liquid Mutual Funds');
      if (isMFInvestmentSubAccount) {
        const isInv = !!(t.InvestmentTransactionType || t.Brokerage || t.SecurityISIN);
        const broker = String(t.Brokerage || '').trim() || (String(t.Source || '').includes('CAS') ? 'Ak ETMoney' : '');
        const isParentMatch = acct === acctName || dest === acctName || String(t.Category || '').includes(acctName);
        if (subAccountName === 'Ak ETMoney') {
          if (isInv && isParentMatch && (broker === 'Ak ETMoney' || String(t.Source || '').includes('CAS') || !broker)) {
            return true;
          }
        }
      }

      const isXfer = t['Income/Expense'] === 'Transfer' || t['Income/Expense'] === 'Transfer-Out' || t['Income/Expense'] === 'Transfer-In';
      if (isXfer) {
        return (acct === acctName && fromSub === subAccountName) || (dest === acctName && toSub === subAccountName);
      } else {
        return acct === acctName && sub === subAccountName;
      }
    }
    return acct === acctName || dest === acctName;
  });
}

const taxSaverTxns = filterAcctTxns('Mutual Funds Tax Saver', 'Ak ETMoney');
console.log(`Mutual Funds Tax Saver › Ak ETMoney: Total Txns = ${taxSaverTxns.length}`);
const taxBuys = taxSaverTxns.filter(t => t.InvestmentTransactionType === 'BUY');
const taxSells = taxSaverTxns.filter(t => t.InvestmentTransactionType === 'SELL');
const taxAdjs = taxSaverTxns.filter(t => t.InvestmentTransactionType === 'UNIT_ADJUSTMENT');
console.log(`  ├── BUYs:  ${taxBuys.length}`);
console.log(`  ├── SELLs: ${taxSells.length}`);
console.log(`  └── ADJs:  ${taxAdjs.length}`);

const liquidMFTxns = filterAcctTxns('Liquid Mutual Funds', 'Ak ETMoney');
console.log(`\nLiquid Mutual Funds › Ak ETMoney: Total Txns = ${liquidMFTxns.length}`);
const liqBuys = liquidMFTxns.filter(t => t.InvestmentTransactionType === 'BUY');
const liqSells = liquidMFTxns.filter(t => t.InvestmentTransactionType === 'SELL');
const liqAdjs = liquidMFTxns.filter(t => t.InvestmentTransactionType === 'UNIT_ADJUSTMENT');
console.log(`  ├── BUYs:  ${liqBuys.length}`);
console.log(`  ├── SELLs: ${liqSells.length}`);
console.log(`  └── ADJs:  ${liqAdjs.length}`);

// Check bank accounts
const hdfcAkTxns = filterAcctTxns('HDFC', 'Ak ETMoney');
const sbiAkTxns = filterAcctTxns('SBI', 'Ak ETMoney');
const smAkTxns = filterAcctTxns('Share Market', 'Ak ETMoney');

console.log(`\nBank Accounts & Share Market Check:`);
console.log(`  ├── HDFC › Ak ETMoney:         ${hdfcAkTxns.length} txns (Must be 0) ${hdfcAkTxns.length === 0 ? '✅' : '❌'}`);
console.log(`  ├── SBI › Ak ETMoney:          ${sbiAkTxns.length} txns (Must be 0) ${sbiAkTxns.length === 0 ? '✅' : '❌'}`);
console.log(`  └── Share Market › Ak ETMoney: ${smAkTxns.length} txns (Must be 0) ${smAkTxns.length === 0 ? '✅' : '❌'}`);

