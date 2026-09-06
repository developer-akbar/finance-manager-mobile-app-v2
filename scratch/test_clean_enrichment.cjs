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

const baseRaw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const baseRows = parseCSV(baseRaw);

const masterCasRaw = fs.readFileSync('finman_2026-08-31_CAS_All_MF_merged_master_v2.csv', 'utf8');
const casRows = parseCSV(masterCasRaw).slice(28786);

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

// 1. Deep clone base rows without mutating any account/subaccount hierarchy
const enrichedRows = baseRows.map(r => {
  const copy = { ...r };
  if (copy.Date === '2024-04-01') copy.Date = '01/04/2024'; // Normalize ISO date
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
        
        // Strict parent asset routing match
        const exDest = ex.ToAccount || '';
        if (exDest !== parentAsset) continue;

        // Never match Ammi Groww or Fareeda Groww rows!
        const exSub = String(ex.SubAccount || ex.ToSubAccount || ex.FromSubAccount || '').toLowerCase();
        const exDesc = String(ex.Description || ex.Note || '').toLowerCase();
        if (exSub.includes('groww') || exSub.includes('fareeda') || exSub.includes('ammi') ||
            exDesc.includes('fareeda') || exDesc.includes('ammi groww')) {
          continue;
        }

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

      // ENRICH ONLY INVESTMENT METADATA COLUMNS!
      // DO NOT TOUCH SubAccount, FromSubAccount, ToSubAccount, FromAccount, ToAccount!
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
    } else {
      // Create Standalone Position BUY Record (CashImpact = 0)
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
        SubAccount: '',
        FromSubAccount: '',
        ToSubAccount: '',
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
    // Create Standalone Position SELL Record (CashImpact = 0)
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
      SubAccount: '',
      FromSubAccount: '',
      ToSubAccount: '',
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
    // Create Standalone Position UNIT_ADJUSTMENT Record (CashImpact = 0)
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
      SubAccount: '',
      FromSubAccount: '',
      ToSubAccount: '',
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

console.log('=== VERIFYING BEFORE VS AFTER HIERARCHY & BALANCES ===\n');

function computeHierarchyAndBalances(rows) {
  const acctBal = {};
  const subBal = {};

  rows.forEach(r => {
    const amt = parseFloat(r.INR || r.Amount || 0);
    const type = String(r['Income/Expense'] || '').trim();
    const acct = String(r.Account || r.FromAccount || '').trim();
    const toAcct = String(r.ToAccount || '').trim();

    const sub = String(r.SubAccount || '').trim();
    const fromSub = String(r.FromSubAccount || r.sub_account || '').trim();
    const toSub = String(r.ToSubAccount || '').trim();

    if (type === 'Income') {
      if (acct) {
        acctBal[acct] = (acctBal[acct] || 0) + amt;
        if (sub) {
          if (!subBal[acct]) subBal[acct] = {};
          subBal[acct][sub] = (subBal[acct][sub] || 0) + amt;
        }
      }
    } else if (type === 'Expense') {
      if (acct) {
        acctBal[acct] = (acctBal[acct] || 0) - amt;
        if (sub) {
          if (!subBal[acct]) subBal[acct] = {};
          subBal[acct][sub] = (subBal[acct][sub] || 0) - amt;
        }
      }
    } else if (type === 'Transfer-Out') {
      if (acct) {
        acctBal[acct] = (acctBal[acct] || 0) - amt;
        if (fromSub) {
          if (!subBal[acct]) subBal[acct] = {};
          subBal[acct][fromSub] = (subBal[acct][fromSub] || 0) - amt;
        }
      }
      if (toAcct) {
        acctBal[toAcct] = (acctBal[toAcct] || 0) + amt;
        if (toSub) {
          if (!subBal[toAcct]) subBal[toAcct] = {};
          subBal[toAcct][toSub] = (subBal[toAcct][toSub] || 0) + amt;
        }
      }
    }
  });

  return { acctBal, subBal };
}

const baseStats = computeHierarchyAndBalances(baseRows);
const enrichedStats = computeHierarchyAndBalances(finalEnrichedMaster);

console.log('--- ACCOUNT & SUBACCOUNT HIERARCHY COMPARISON ---');
let diffFound = false;
for (const [acct, bal] of Object.entries(baseStats.acctBal)) {
  const enrBal = enrichedStats.acctBal[acct] || 0;
  const match = Math.abs(bal - enrBal) < 0.001;
  if (!match) {
    diffFound = true;
    console.log(`❌ MISMATCH in Account "${acct}": Base=₹${bal.toFixed(2)} vs Enriched=₹${enrBal.toFixed(2)}`);
  } else {
    console.log(`✅ ${acct.padEnd(25)}: ₹${bal.toFixed(2)} (Match)`);
  }

  // Check subaccounts
  const baseSubs = baseStats.subBal[acct] || {};
  const enrSubs = enrichedStats.subBal[acct] || {};

  const allSubs = new Set([...Object.keys(baseSubs), ...Object.keys(enrSubs)]);
  allSubs.forEach(s => {
    const bSVal = baseSubs[s] || 0;
    const eSVal = enrSubs[s] || 0;
    const sMatch = Math.abs(bSVal - eSVal) < 0.001;
    if (!sMatch) {
      diffFound = true;
      console.log(`   ❌ Subaccount MISMATCH under "${acct} -> ${s}": Base=₹${bSVal.toFixed(2)} vs Enriched=₹${eSVal.toFixed(2)}`);
    } else {
      console.log(`   └── ${s.padEnd(21)}: ₹${bSVal.toFixed(2)} (Match)`);
    }
  });
}

console.log(`\nOverall Hierarchy and Balance Verification: ${!diffFound ? '✅ 100% PERFECT MATCH' : '❌ FAILED'}`);

// Also save to clean preview
fs.writeFileSync('scratch/finman_CAS_enriched_master_preview_v3.csv', stringifyCSV(finalEnrichedMaster), 'utf8');
console.log(`Saved clean dataset to scratch/finman_CAS_enriched_master_preview_v3.csv (${finalEnrichedMaster.length} rows)`);

