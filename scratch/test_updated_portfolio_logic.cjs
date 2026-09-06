const fs = require('fs');
const { calculateBrokerageState, parseTxnFields } = require('../src/utils/brokerageAccounting.js');

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

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const transactions = parseCSV(raw);

const brokerages = [{ name: 'Zerodha' }, { name: 'Fareeda Groww', totalValue: 123003 }, { name: 'Groww' }];
const smBalances = calculateBrokerageState(transactions, brokerages, {});

// Build the complete portfolio calculation logic
function calculateCleanPortfolio(selectedAsset = 'All') {
  // 1. Brokerage values
  const zerodha = smBalances['Zerodha'];
  const fareedaGroww = smBalances['Fareeda Groww'];

  // 2. Ledger accounts
  const accountBalances = {};
  const investedCapital = {};
  const historicalRealizedPnL = {};

  transactions.forEach(t => {
    const grp = t.AccountGroup || t.FromAccountGroup || '';
    const acct = t.Account || t.FromAccount || '';
    const toAcct = t.ToAccount || '';
    const toGrp = t.ToAccountGroup || '';
    const amt = parseFloat(t.INR || t.Amount || 0);
    const type = t['Income/Expense'] || '';
    const sub = t.SubAccount || t.FromSubAccount || '';
    const toSub = t.ToSubAccount || '';
    const cat = t.Category || '';
    const subcat = t.Subcategory || '';

    // Track ledger balances and invested principal for non-ShareMarket investment accounts
    if ((grp === 'Investments' || toGrp === 'Investments') && acct !== 'Share Market' && toAcct !== 'Share Market') {
      const srcKey = sub ? `${acct} > ${sub}` : acct;
      const destKey = toSub ? `${toAcct} > ${toSub}` : toAcct;

      if (grp === 'Investments') {
        if (!accountBalances[srcKey]) accountBalances[srcKey] = 0;
        if (!investedCapital[srcKey]) investedCapital[srcKey] = 0;
        if (type === 'Transfer-Out') {
          accountBalances[srcKey] -= amt;
          investedCapital[srcKey] -= amt;
        } else if (type === 'Expense') {
          accountBalances[srcKey] -= amt;
        } else if (type === 'Income') {
          accountBalances[srcKey] += amt;
        }
      }

      if (toGrp === 'Investments') {
        if (!accountBalances[destKey]) accountBalances[destKey] = 0;
        if (!investedCapital[destKey]) investedCapital[destKey] = 0;
        if (type === 'Transfer-Out') {
          accountBalances[destKey] += amt;
          investedCapital[destKey] += amt;
        }
      }
    }

    // Track Realized P&L from historical MF rows
    if (cat === 'Equity') {
      if (subcat === 'Tax MF Gains') {
        historicalRealizedPnL['Mutual Funds Tax Saver'] = (historicalRealizedPnL['Mutual Funds Tax Saver'] || 0) + amt;
      } else if (subcat === 'Liquid MF Gains' || subcat === 'Liquid MF Losses') {
        historicalRealizedPnL['Liquid Mutual Funds'] = (historicalRealizedPnL['Liquid Mutual Funds'] || 0) + amt;
      }
    }
  });

  // Calculate totals based on selectedAsset
  let totalPortfolioValue = 0;
  let totalInvestedCapital = 0;
  let isInvestedCostTracked = true;
  let totalUnrealizedPnL = 0;
  let totalRealizedPnL = 0;
  let totalDividends = 0;

  if (selectedAsset === 'All') {
    // Current Portfolio Value: Zerodha (Holdings + Cash) + Fareeda Groww + Ledger Accounts
    totalPortfolioValue = zerodha.totalValue + fareedaGroww.totalValue;
    Object.values(accountBalances).forEach(b => totalPortfolioValue += b);

    // Active Invested Capital: Zerodha Cost Basis + Tracked Ledger Principal
    totalInvestedCapital = zerodha.investedCost;
    Object.values(investedCapital).forEach(c => totalInvestedCapital += c);

    // Active Unrealized P&L: Zerodha
    totalUnrealizedPnL = zerodha.unrealizedPnL;

    // Historical Realized P&L: Zerodha Net Trading + MF Realized
    totalRealizedPnL = zerodha.netTradingPnL;
    Object.values(historicalRealizedPnL).forEach(p => totalRealizedPnL += p);

    // Historical Dividends: Zerodha
    totalDividends = 2178.55;
  } else if (selectedAsset === 'Share Market') {
    totalPortfolioValue = zerodha.totalValue + fareedaGroww.totalValue;
    totalInvestedCapital = zerodha.investedCost; // Note: Zerodha only
    isInvestedCostTracked = false; // Because Fareeda Groww cost is unavailable
    totalUnrealizedPnL = zerodha.unrealizedPnL;
    totalRealizedPnL = zerodha.netTradingPnL;
    totalDividends = 2178.55;
  } else if (selectedAsset === 'Mutual Funds Tax Saver') {
    totalPortfolioValue = accountBalances['Mutual Funds Tax Saver'] || 0;
    totalInvestedCapital = investedCapital['Mutual Funds Tax Saver'] || 0;
    totalUnrealizedPnL = 0;
    totalRealizedPnL = historicalRealizedPnL['Mutual Funds Tax Saver'] || 0;
    totalDividends = 0;
  } else if (selectedAsset === 'Liquid Mutual Funds') {
    totalPortfolioValue = (accountBalances['Liquid Mutual Funds > Ammi Groww'] || 0) + (accountBalances['Liquid Mutual Funds > Fareeda Groww'] || 0);
    totalInvestedCapital = (investedCapital['Liquid Mutual Funds > Ammi Groww'] || 0) + (investedCapital['Liquid Mutual Funds > Fareeda Groww'] || 0);
    totalUnrealizedPnL = 0;
    totalRealizedPnL = historicalRealizedPnL['Liquid Mutual Funds'] || 0;
    totalDividends = 0;
  }

  return {
    selectedAsset,
    totalPortfolioValue,
    totalInvestedCapital,
    isInvestedCostTracked,
    totalUnrealizedPnL,
    totalRealizedPnL,
    totalDividends,
    accountBalances,
    investedCapital,
    historicalRealizedPnL,
    zerodha,
    fareedaGroww
  };
}

console.log('=== TEST ALL PORTFOLIO ===');
const all = calculateCleanPortfolio('All');
console.log('1. Current Portfolio Value:    ₹' + all.totalPortfolioValue.toFixed(2));
console.log('2. Active Invested Capital:     ₹' + all.totalInvestedCapital.toFixed(2));
console.log('3. Active Unrealized P&L:      ₹' + all.totalUnrealizedPnL.toFixed(2));
console.log('4. Historical Realized P&L:    ₹' + all.totalRealizedPnL.toFixed(2));
console.log('   - Zerodha Net Trading:       ₹' + all.zerodha.netTradingPnL.toFixed(2));
console.log('   - Tax Saver MF:              ₹' + all.historicalRealizedPnL['Mutual Funds Tax Saver'].toFixed(2));
console.log('   - Liquid MF:                 ₹' + all.historicalRealizedPnL['Liquid Mutual Funds'].toFixed(2));
console.log('5. Historical Dividends:       ₹' + all.totalDividends.toFixed(2));

console.log('\n=== TEST SHARE MARKET ===');
const sm = calculateCleanPortfolio('Share Market');
console.log('1. Share Market Current Value: ₹' + sm.totalPortfolioValue.toFixed(2));
console.log('   - Zerodha:                   ₹' + sm.zerodha.totalValue.toFixed(2));
console.log('   - Fareeda Groww:             ₹' + sm.fareedaGroww.totalValue.toFixed(2));
console.log('2. Zerodha Invested Cost:      ₹' + sm.zerodha.investedCost.toFixed(2));
console.log('   Fareeda Groww Cost Basis:    Cost basis not tracked');
console.log('3. Active Unrealized P&L:      ₹' + sm.totalUnrealizedPnL.toFixed(2));
console.log('4. Zerodha Realized P&L:       ₹' + sm.totalRealizedPnL.toFixed(2));
console.log('5. Zerodha Dividends:          ₹' + sm.totalDividends.toFixed(2));

