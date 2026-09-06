const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

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

function stringifyCSV(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];

  for (const r of rows) {
    const rowFields = headers.map(h => {
      const val = String(r[h] !== undefined && r[h] !== null ? r[h] : '');
      if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    lines.push(rowFields.join(','));
  }
  return lines.join('\n');
}

const masterRaw = fs.readFileSync('finman_2026-08-31_CAS_All_MF_merged_master_v2.csv', 'utf8');
const allRows = parseCSV(masterRaw);

const baseFinManRows = allRows.slice(0, 28786);
const casRows = allRows.slice(28786);

function parseDate(dStr) {
  if (!dStr) return new Date(0);
  const p = dStr.split('/');
  if (p.length === 3) return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
  return new Date(dStr);
}

function getFundKeyword(str) {
  const s = (str || '').toLowerCase();
  if (s.includes('canara') || s.includes('robeco')) return 'canara';
  if (s.includes('dsp')) return 'dsp';
  if (s.includes('mirae')) return 'mirae';
  if (s.includes('motilal')) return 'motilal';
  if (s.includes('quant')) return 'quant';
  if (s.includes('franklin')) return 'franklin';
  if (s.includes('nippon') || s.includes('reliance')) return 'nippon';
  if (s.includes('l&t') || s.includes('tax advantage') || s.includes('hsbc')) return 'l&t';
  if (s.includes('kotak')) return 'kotak';
  return '';
}

const taxSaverSchemes = new Set([
  'INF760K01100', 'INF760K01EL8', 'INF740K01185', 'INF740K01OK1',
  'INF677K01064', 'INF769K01DK3', 'INF769K01DM9', 'INF247L01544',
  'INF247L01569', 'INF966L01986'
]);

const enrichedRows = baseFinManRows.map(r => {
  const copy = { ...r };
  if (copy.Date === '2024-04-01') copy.Date = '01/04/2024';
  return copy;
});
const usedExistingIds = new Set();
const newPositionRecords = [];

const sortedCasRows = [...casRows].map((r, i) => ({ ...r, originalCasIndex: i + 1 }));

sortedCasRows.forEach((cas) => {
  const type = cas.InvestmentTransactionType;
  const isin = cas.SecurityISIN;
  const isTax = taxSaverSchemes.has(isin);
  const parentAsset = isTax ? 'Mutual Funds Tax Saver' : 'Liquid Mutual Funds';
  const subAccount = 'Ak ETMoney';
  const scheme = cas.SecuritySymbol || cas.Description;
  const folio = cas.FolioNumber || cas.Folio || '';
  const qty = parseFloat(cas.Quantity || 0);
  const nav = parseFloat(cas.UnitPrice || 0);
  const tradeVal = parseFloat(cas.TradeValue || cas.INR || cas.Amount || 0);
  const costBasis = parseFloat(cas.CostBasis || tradeVal);
  const realizedPnl = parseFloat(cas.RealizedPnl || (tradeVal - costBasis));
  const casKw = getFundKeyword(scheme);
  const casDate = parseDate(cas.Date);

  if (type === 'BUY') {
    let matchIdx = -1;
    const dayPasses = [5, 15, 35, 60];

    for (const maxDays of dayPasses) {
      if (matchIdx !== -1) break;
      for (let i = 0; i < enrichedRows.length; i++) {
        const ex = enrichedRows[i];
        if (usedExistingIds.has(ex.ID)) continue;
        if (ex['Income/Expense'] !== 'Transfer-Out') continue;
        
        const exDest = ex.ToAccount || '';
        if (exDest !== parentAsset) continue;

        const exAmt = parseFloat(ex.INR || ex.Amount || 0);
        const amtDiff = Math.abs(exAmt - tradeVal);
        if (amtDiff > 5.0 && Math.abs(amtDiff - Math.round(tradeVal)) > 5.0) continue;

        const exDate = parseDate(ex.Date);
        const dayDiff = Math.abs((casDate - exDate) / (1000 * 60 * 60 * 24));
        if (dayDiff > maxDays) continue;

        const exKw = getFundKeyword((ex.Note || '') + ' ' + (ex.Description || ''));
        if (casKw && exKw && casKw !== exKw) continue;

        matchIdx = i;
        break;
      }
    }

    if (matchIdx !== -1) {
      const target = enrichedRows[matchIdx];
      usedExistingIds.add(target.ID);

      target.InvestmentTransactionType = 'BUY';
      target.Brokerage = 'Ak ETMoney';
      target.SecuritySymbol = scheme;
      target.SecurityISIN = isin;
      target.FolioNumber = folio;
      target.Quantity = String(qty);
      target.UnitPrice = String(nav);
      target.TradeValue = String(tradeVal);
      target.CostBasis = String(tradeVal);
      target.PositionQuantityChange = String(qty);
      target.RealizedPnl = '0.0';
      target.CashImpact = '0.0';
      target.Source = 'CAMS_CAS';
      target.ToSubAccount = subAccount;
      if (!target.SubAccount) target.SubAccount = subAccount;
    } else {
      const buyRec = {
        Date: cas.Date,
        Time: '12:00',
        Account: '',
        AccountGroup: '',
        AccountType: '',
        CardLast4: '',
        SettlementDate: '',
        PaymentDueDays: '',
        AccountOrder: '',
        AccountGroupOrder: '',
        FromAccount: parentAsset,
        FromAccountGroup: 'Investments',
        FromAccountOrder: '0',
        ToAccount: parentAsset,
        ToAccountGroup: 'Investments',
        ToAccountOrder: '0',
        Category: parentAsset,
        Subcategory: '',
        Note: scheme,
        Description: `CAS MF PURCHASE | Scheme=${scheme} | ISIN=${isin} | Folio=${folio} | Units=${qty} | NAV=${nav} | Cost=${tradeVal} | Source=CAMS_CAS`,
        INR: '0.0',
        Amount: '0.0',
        Currency: 'INR',
        'Income/Expense': 'Transfer-Out',
        Tags: `MF|Purchase|${isin}`,
        recurring_rule_id: '',
        warranty_expiry: '',
        serial_no: '',
        receipt_image: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ID: cas.ID || `cas-buy-${cas.originalCasIndex}-${isin}`,
        SubAccount: subAccount,
        FromSubAccount: subAccount,
        ToSubAccount: subAccount,
        InvestmentTransactionType: 'BUY',
        Brokerage: 'Ak ETMoney',
        SecuritySymbol: scheme,
        SecurityISIN: isin,
        Quantity: String(qty),
        UnitPrice: String(nav),
        TradeValue: String(tradeVal),
        CostBasis: String(tradeVal),
        CashImpact: '0.0',
        PositionQuantityChange: String(qty),
        RealizedPnl: '0.0',
        TradeId: '',
        OrderId: '',
        Exchange: '',
        Segment: '',
        Source: 'CAMS_CAS'
      };
      newPositionRecords.push(buyRec);
    }
  } else if (type === 'SELL') {
    const sellRec = {
      Date: cas.Date,
      Time: '12:00',
      Account: '',
      AccountGroup: '',
      AccountType: '',
      CardLast4: '',
      SettlementDate: '',
      PaymentDueDays: '',
      AccountOrder: '',
      AccountGroupOrder: '',
      FromAccount: parentAsset,
      FromAccountGroup: 'Investments',
      FromAccountOrder: '0',
      ToAccount: parentAsset,
      ToAccountGroup: 'Investments',
      ToAccountOrder: '0',
      Category: parentAsset,
      Subcategory: '',
      Note: scheme,
      Description: `CAS MF REDEMPTION | Scheme=${scheme} | ISIN=${isin} | Folio=${folio} | Units=${qty} | NAV=${nav} | Proceeds=${tradeVal} | CostBasis=${costBasis} | RealizedPL=${realizedPnl} | Source=CAMS_CAS`,
      INR: '0.0',
      Amount: '0.0',
      Currency: 'INR',
      'Income/Expense': 'Transfer-Out',
      Tags: `MF|Redemption|${isin}`,
      recurring_rule_id: '',
      warranty_expiry: '',
      serial_no: '',
      receipt_image: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ID: cas.ID || `cas-sell-${cas.originalCasIndex}-${isin}`,
      SubAccount: subAccount,
      FromSubAccount: subAccount,
      ToSubAccount: subAccount,
      InvestmentTransactionType: 'SELL',
      Brokerage: 'Ak ETMoney',
      SecuritySymbol: scheme,
      SecurityISIN: isin,
      Quantity: String(qty),
      UnitPrice: String(nav),
      TradeValue: String(tradeVal),
      CostBasis: String(costBasis),
      CashImpact: '0.0',
      PositionQuantityChange: String(-qty),
      RealizedPnl: String(realizedPnl),
      TradeId: '',
      OrderId: '',
      Exchange: '',
      Segment: '',
      Source: 'CAMS_CAS'
    };
    newPositionRecords.push(sellRec);
  } else if (type === 'UNIT_ADJUSTMENT') {
    const adjRec = {
      Date: cas.Date,
      Time: '12:00',
      Account: '',
      AccountGroup: '',
      AccountType: '',
      CardLast4: '',
      SettlementDate: '',
      PaymentDueDays: '',
      AccountOrder: '',
      AccountGroupOrder: '',
      FromAccount: parentAsset,
      FromAccountGroup: 'Investments',
      FromAccountOrder: '0',
      ToAccount: parentAsset,
      ToAccountGroup: 'Investments',
      ToAccountOrder: '0',
      Category: parentAsset,
      Subcategory: '',
      Note: scheme,
      Description: `CAS UNIT ADJUSTMENT | Scheme=${scheme} | ISIN=${isin} | Units=${qty} | Source=CAMS_CAS`,
      INR: '0.0',
      Amount: '0.0',
      Currency: 'INR',
      'Income/Expense': 'Transfer-Out',
      Tags: `MF|UnitAdjustment|${isin}`,
      recurring_rule_id: '',
      warranty_expiry: '',
      serial_no: '',
      receipt_image: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ID: cas.ID || `cas-adj-${cas.originalCasIndex}-${isin}`,
      SubAccount: subAccount,
      FromSubAccount: subAccount,
      ToSubAccount: subAccount,
      InvestmentTransactionType: 'UNIT_ADJUSTMENT',
      Brokerage: 'Ak ETMoney',
      SecuritySymbol: scheme,
      SecurityISIN: isin,
      Quantity: String(qty),
      UnitPrice: '0.0',
      TradeValue: '0.0',
      CostBasis: '0.0',
      CashImpact: '0.0',
      PositionQuantityChange: String(qty),
      RealizedPnl: '0.0',
      TradeId: '',
      OrderId: '',
      Exchange: '',
      Segment: '',
      Source: 'CAMS_CAS'
    };
    newPositionRecords.push(adjRec);
  }
});

const finalEnrichedMaster = [...enrichedRows, ...newPositionRecords];
const outPath = path.resolve('scratch/finman_CAS_enriched_master_preview_v2.csv');

// Write out safely
fs.writeFileSync(outPath, stringifyCSV(finalEnrichedMaster), { encoding: 'utf8', flag: 'w' });

// Stat and hash verification
const fileBuffer = fs.readFileSync(outPath);
const hashSum = crypto.createHash('sha256');
hashSum.update(fileBuffer);
const hexHash = hashSum.digest('hex');

const stat = fs.statSync(outPath);

console.log('=== PHYSICAL FILE INSPECTION & VERIFICATION ===');
console.log(`FILE PATH:          ${outPath}`);
console.log(`MODIFIED TIMESTAMP: ${stat.mtime.toISOString()}`);
console.log(`FILE SIZE:          ${stat.size} bytes`);
console.log(`SHA-256:            ${hexHash}`);
console.log(`ROW COUNT:          ${finalEnrichedMaster.length}`);

// First 5 and Last 5 Rows
console.log('\n--- FIRST 5 ROWS ---');
for (let i = 0; i < Math.min(5, finalEnrichedMaster.length); i++) {
  const r = finalEnrichedMaster[i];
  console.log(`[Row ${i+1}] Date=${r.Date} | Type=${r['Income/Expense']} | Account=${r.Account} | From=${r.FromAccount} | To=${r.ToAccount} | INR=${r.INR} | Note=${r.Note.slice(0, 25)} | InvType=${r.InvestmentTransactionType || ''}`);
}

console.log('\n--- LAST 5 ROWS ---');
for (let i = finalEnrichedMaster.length - 5; i < finalEnrichedMaster.length; i++) {
  const r = finalEnrichedMaster[i];
  console.log(`[Row ${i+1}] Date=${r.Date} | Type=${r['Income/Expense']} | Account=${r.Account} | From=${r.FromAccount} | To=${r.ToAccount} | INR=${r.INR} | Scheme=${r.SecuritySymbol.slice(0, 25)} | InvType=${r.InvestmentTransactionType}`);
}

// Check CAMS_CAS counts
const casTotal = finalEnrichedMaster.filter(r => r.Source === 'CAMS_CAS');
const buys = casTotal.filter(r => r.InvestmentTransactionType === 'BUY');
const sells = casTotal.filter(r => r.InvestmentTransactionType === 'SELL');
const adjs = casTotal.filter(r => r.InvestmentTransactionType === 'UNIT_ADJUSTMENT');

console.log('\n--- CAS COMPONENT COUNTS IN PHYSICAL CSV ---');
console.log(`CAS BUY:             ${buys.length}`);
console.log(`CAS SELL:            ${sells.length}`);
console.log(`CAS UNIT_ADJUSTMENT: ${adjs.length}`);
console.log(`TOTAL CAS ROWS:      ${casTotal.length} / 163`);

// Zerodha Recon Row Check
const recon = finalEnrichedMaster.find(r => r.InvestmentTransactionType === 'RECONCILIATION');
console.log('\n--- ZERODHA RECONCILIATION ROW ---');
console.log(`Found: ${!!recon} | Date: ${recon?.Date} | INR: ${recon?.INR} | CashImpact: ${recon?.CashImpact} | Source: "${recon?.Source || 'BASE_CSV'}"`);

