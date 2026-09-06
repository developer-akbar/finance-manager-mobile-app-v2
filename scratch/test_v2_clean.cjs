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

const activeHoldingsData = {
  "VMM": { "quantity": 190.0, "averagePrice": 78.00, "investedValue": 14820.0, "unrealizedPnL": 4864.0, "currentValue": 19684.0 },
  "SAMPANN": { "quantity": 60.0, "averagePrice": 36.20, "investedValue": 2171.75, "unrealizedPnL": -614.75, "currentValue": 1557.0 },
  "DEVYANI": { "quantity": 20.0, "averagePrice": 161.60, "investedValue": 3232.0, "unrealizedPnL": -344.0, "currentValue": 2888.0 },
  "JPPOWER": { "quantity": 100.0, "averagePrice": 7.45, "investedValue": 745.0, "unrealizedPnL": 966.0, "currentValue": 1711.0 },
  "URJA": { "quantity": 140.0, "averagePrice": 13.55, "investedValue": 1897.0, "unrealizedPnL": -588.0, "currentValue": 1309.0 },
  "NTPC": { "quantity": 1.0, "averagePrice": 409.00, "investedValue": 409.0, "unrealizedPnL": -68.95, "currentValue": 340.05 },
  "SUZLON": { "quantity": 60.0, "averagePrice": 10.90, "investedValue": 654.0, "unrealizedPnL": 2151.6, "currentValue": 2805.6 },
  "TATAPOWER": { "quantity": 70.0, "averagePrice": 229.08, "investedValue": 16035.5, "unrealizedPnL": 10204.0, "currentValue": 26239.5 },
  "WIPRO": { "quantity": 4.0, "averagePrice": 275.38, "investedValue": 1101.5, "unrealizedPnL": -378.34, "currentValue": 723.16 }
};

function parseTxnFields(t) {
  if (!t) return null;
  const desc = String(t.Description || t.description || '').trim();
  const type = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim();
  const isShareMarketTxn = 
    String(t.Account || t.account || '').trim() === 'Share Market' ||
    String(t.FromAccount || t.from_account || '').trim() === 'Share Market' ||
    String(t.ToAccount || t.to_account || '').trim() === 'Share Market' ||
    !!(t.Brokerage || t.brokerage);

  if (type === 'RECONCILIATION' || desc.startsWith('RECONCILIATION')) {
    let broker = String(t.Brokerage || t.brokerage || '').trim();
    let cashImpact = parseFloat(t.CashImpact !== undefined && t.CashImpact !== '' ? t.CashImpact : (t.cash_impact !== undefined && t.cash_impact !== '' ? t.cash_impact : (t.INR || t.inr || t.Amount || t.amount || 0)));
    if (desc.includes('|')) {
      const parts = desc.split('|').map(p => p.trim());
      parts.forEach(p => {
        const m = p.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
        if (m) {
          if (m[1] === 'Broker' || m[1] === 'Brokerage') broker = m[2].trim();
          if (m[1] === 'Amount' || m[1] === 'CashImpact') cashImpact = parseFloat(m[2].trim());
        }
      });
    }
    if (!broker && isShareMarketTxn) {
      broker = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
    }
    return {
      type: 'RECONCILIATION',
      brokerage: broker,
      symbol: '',
      qty: 0,
      cost: 0,
      costBasis: 0,
      cashImpact,
      realizedPnL: 0,
      activeHolding: 'NO',
      isRecon: true
    };
  }

  if (type) {
    const isRecon = desc.includes('EntryDate=UNKNOWN') || desc.includes('historical position closure') || desc.includes('Source=CurrentP&L') || desc.includes('reconciliation');
    return {
      type,
      brokerage: String(t.Brokerage || t.brokerage || t.SubAccount || t.sub_account || '').trim(),
      symbol: String(t.SecuritySymbol || t.security_symbol || t.Note || t.note || '').trim().toUpperCase(),
      qty: parseFloat(t.Quantity || t.quantity || 0),
      cost: parseFloat(t.TradeValue || t.trade_value || 0),
      costBasis: parseFloat(t.CostBasis || t.cost_basis || 0),
      cashImpact: isRecon ? 0 : parseFloat(t.CashImpact || t.cash_impact || t.INR || t.inr || t.Amount || t.amount || 0),
      realizedPnL: parseFloat(t.RealizedPnl || t.realized_pnl || 0),
      activeHolding: desc.includes('ActiveHolding=NO') || String(t.Note || t.note || '').includes('ActiveHolding=NO') ? 'NO' : 'YES',
      isRecon
    };
  }
  
  const investmentTypes = new Set(['BUY', 'BUY_RECON', 'SELL', 'OPENING_LOT', 'BONUS', 'POSITION_STATUS', 'REALIZED_PNL', 'CHARGE', 'OTHER_CREDIT_DEBIT', 'FUNDING', 'WITHDRAWAL', 'DIVIDEND', 'RECONCILIATION']);
  
  if (desc.includes('|')) {
    const parts = desc.split('|').map(p => p.trim());
    const parsedType = parts[0];
    if (investmentTypes.has(parsedType) || parsedType === 'BUY_RECON') {
      const fields = {};
      parts.forEach(p => {
        const m = p.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
        if (m) fields[m[1]] = m[2].trim();
      });
      
      const broker = fields.Broker || fields.Brokerage || (isShareMarketTxn ? String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim() : '');
      const symbol = fields.Symbol || String(t.Note || t.note || '').trim().toUpperCase();
      const qty = parseFloat(fields.Qty || fields.Quantity || 0);
      const cost = parseFloat(fields.Cost || fields.CostBasis || fields.TradeValue || (fields.Price ? qty * parseFloat(fields.Price) : 0) || 0);
      const costBasis = parseFloat(fields.CostBasis || 0);
      const realizedPnL = parseFloat(fields.RealizedPL || fields.RealizedPnL || 0);
      const activeHolding = fields.ActiveHolding || (desc.includes('ActiveHolding=NO') ? 'NO' : 'YES');
      const isRecon = parsedType === 'BUY_RECON' || parsedType === 'RECONCILIATION' || desc.includes('EntryDate=UNKNOWN') || desc.includes('historical position closure') || desc.includes('Source=CurrentP&L') || desc.includes('reconciliation');
      
      let cashImpact = parseFloat(t.INR || t.inr || t.Amount || t.amount || 0);
      if (parsedType === 'RECONCILIATION') {
        cashImpact = parseFloat(fields.Amount || fields.CashImpact || t.INR || t.inr || t.Amount || t.amount || 0);
      } else if (isRecon) {
        cashImpact = 0;
      }

      return {
        type: parsedType,
        brokerage: broker,
        symbol,
        qty,
        cost,
        costBasis,
        cashImpact,
        realizedPnL,
        activeHolding,
        isRecon
      };
    }
  }
  
  const broker = isShareMarketTxn ? String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim() : '';
  const symbol = isShareMarketTxn ? String(t.Note || t.note || '').trim().toUpperCase() : '';
  const isRecon = desc.includes('reconciliation') || desc.includes('BUY_RECON') || desc.includes('EntryDate=UNKNOWN');

  return {
    type: String(t.InvestmentTransactionType || t.investment_transaction_type || t.Category || t.category || '').trim(),
    brokerage: broker,
    symbol,
    qty: 0,
    cost: 0,
    costBasis: 0,
    cashImpact: isRecon ? 0 : parseFloat(t.INR || t.inr || t.Amount || t.amount || 0),
    realizedPnL: 0,
    activeHolding: 'YES',
    isRecon
  };
}

function calculateBrokerageState(txns = [], brokerConfigList = [], settings = {}) {
  const brokerages = new Set(brokerConfigList.map(b => b.name || b).filter(Boolean));

  txns.forEach(t => {
    const isSM = String(t.Account || t.account || '').trim() === 'Share Market' ||
      String(t.FromAccount || t.from_account || '').trim() === 'Share Market' ||
      String(t.ToAccount || t.to_account || '').trim() === 'Share Market';
    if (isSM) {
      const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
      if (sub) brokerages.add(sub);
    }
    const f = parseTxnFields(t);
    if (f && f.brokerage) brokerages.add(f.brokerage);
  });

  const results = {};
  let holdingsPrices = {};
  try {
    holdingsPrices = JSON.parse(settings.holdings_prices || '{}');
  } catch {}

  brokerages.forEach(broker => {
    if (!broker || broker === 'Share Market') return;

    const brokerTxns = txns.filter(t => {
      const isSM = String(t.Account || t.account || '').trim() === 'Share Market' ||
        String(t.FromAccount || t.from_account || '').trim() === 'Share Market' ||
        String(t.ToAccount || t.to_account || '').trim() === 'Share Market';
      const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
      const f = parseTxnFields(t);
      return (f && f.brokerage === broker) || (isSM && sub === broker);
    });

    let cashBalance = 0;
    let bankFunding = 0;
    let bankWithdrawals = 0;
    let genuineBuyCash = 0;
    let genuineSellCash = 0;
    let charges = 0;
    let otherCreditDebit = 0;
    let reconciliationCash = 0;

    let grossRealizedGains = 0;
    let grossRealizedLosses = 0;

    brokerTxns.forEach(t => {
      const f = parseTxnFields(t);
      if (!f) return;
      const desc = String(t.Description || t.description || '').trim();
      const note = String(t.Note || t.note || '').trim();
      const type = String(t['Income/Expense'] || t.type || '').trim();
      const acct = String(t.Account || t.account || t.FromAccount || t.from_account || '').trim();
      const dest = String(t.ToAccount || t.to_account || '').trim();
      const inr = parseFloat(t.INR || t.inr || t.Amount || t.amount || 0);

      // --- Cash Ledger Rules ---
      if (f.type === 'RECONCILIATION' || desc.startsWith('RECONCILIATION')) {
        reconciliationCash += f.cashImpact;
        cashBalance += f.cashImpact;
      } else if (f.type === 'BUY' && !f.isRecon) {
        genuineBuyCash += inr;
        cashBalance -= inr;
      } else if (f.type === 'SELL') {
        genuineSellCash += inr;
        cashBalance += inr;
      } else if (f.type === 'CHARGE' || note.includes('Charges') || desc.includes('trading charges') || desc.includes('Charges')) {
        charges += inr;
        cashBalance += inr;
      } else if (f.type === 'OTHER_CREDIT_DEBIT' || note.includes('Other Credit & Debit') || desc.includes('Other Credit & Debit')) {
        otherCreditDebit += inr;
        cashBalance += inr;
      } else if (type === 'Transfer-Out' || type.toLowerCase() === 'transfer') {
        if (acct !== 'Share Market' && dest === 'Share Market') {
          bankFunding += inr;
          cashBalance += inr;
        } else if (acct === 'Share Market' && dest !== 'Share Market') {
          bankWithdrawals += inr;
          cashBalance -= inr;
        }
      }

      // --- Performance / Realized P&L Rules (RECONCILIATION is strictly excluded) ---
      if (f.type === 'REALIZED_PNL') {
        if (f.realizedPnL > 0) grossRealizedGains += f.realizedPnL;
        else grossRealizedLosses += f.realizedPnL;
      } else if (note.includes('Gains')) {
        grossRealizedGains += inr;
      } else if (note.includes('Losses')) {
        grossRealizedLosses += inr;
      } else if (desc.includes('Realized P&L reconciliation')) {
        if (inr > 0) grossRealizedGains += inr;
        else grossRealizedLosses += inr;
      }
    });

    const grossRealizedPnL = grossRealizedGains + grossRealizedLosses;
    const netTradingPnL = grossRealizedPnL + charges + otherCreditDebit;

    const holdings = {};
    brokerTxns.forEach(t => {
      const f = parseTxnFields(t);
      if (!f) return;
      const isTrade = f.type === 'BUY' || f.type === 'BUY_RECON' || f.type === 'SELL' || f.type === 'OPENING_LOT' || f.type === 'BONUS';
      if (isTrade && f.symbol) {
        if (!holdings[f.symbol]) {
          holdings[f.symbol] = { symbol: f.symbol, qty: 0, buyCost: 0, soldCostBasis: 0, activeStatus: null };
        }
        const h = holdings[f.symbol];
        if (f.type === 'BUY' || f.type === 'BUY_RECON' || f.type === 'OPENING_LOT' || f.type === 'BONUS') {
          h.qty += f.qty;
          h.buyCost += f.cost;
        } else if (f.type === 'SELL') {
          h.qty -= f.qty;
          h.soldCostBasis += f.costBasis;
        }
      } else if (f.type === 'POSITION_STATUS' && f.symbol) {
        if (!holdings[f.symbol]) {
          holdings[f.symbol] = { symbol: f.symbol, qty: 0, buyCost: 0, soldCostBasis: 0, activeStatus: null };
        }
        if (f.activeHolding === 'NO') {
          holdings[f.symbol].activeStatus = 'NO';
        }
      }
    });

    let investedCost = 0;
    let currentMarketValue = 0;
    const activeHoldings = [];
    const redeemedHoldings = [];

    // Strictly data-driven: no hardcoded symbol exclusions
    Object.values(holdings).forEach(h => {
      const isActive = h.qty > 0 && h.activeStatus !== 'NO';
      if (isActive) {
        const cost = h.buyCost - h.soldCostBasis;
        investedCost += cost;

        let price = holdingsPrices[h.symbol] || 0;
        if (price === 0) {
          const dbHold = activeHoldingsData[h.symbol];
          if (dbHold) {
            price = dbHold.currentValue / dbHold.quantity;
          } else {
            price = cost / h.qty;
          }
        }

        const value = h.qty * price;
        currentMarketValue += value;

        activeHoldings.push({
          symbol: h.symbol,
          qty: h.qty,
          investedCost: cost,
          currentPrice: price,
          currentValue: value,
          unrealizedPnL: value - cost
        });
      } else {
        redeemedHoldings.push({
          symbol: h.symbol,
          qty: h.qty,
          buyCost: h.buyCost,
          soldCostBasis: h.soldCostBasis
        });
      }
    });

    let totalPortfolioValue = cashBalance + currentMarketValue;

    const config = brokerConfigList.find(b => (b.name || b) === broker);
    if (config && config.totalValue) {
      totalPortfolioValue = parseFloat(config.totalValue);
    }

    const unrealizedPnL = currentMarketValue - investedCost;

    results[broker] = {
      broker,
      cash: cashBalance,
      cashBalance,
      bankFunding,
      bankWithdrawals,
      genuineBuyCash,
      genuineSellCash,
      charges,
      otherCreditDebit,
      reconciliationCash,
      investedCost,
      currentValue: currentMarketValue,
      currentMarketValue,
      totalValue: totalPortfolioValue,
      totalPortfolioValue,
      unrealizedPnL,
      grossRealizedGains,
      grossRealizedLosses,
      grossRealizedPnL,
      netTradingPnL,
      activeHoldings,
      redeemedHoldings,
      activeCount: activeHoldings.length,
      redeemedCount: redeemedHoldings.length
    };
  });

  return results;
}

// 1. Audit of dividends in finman_2026-08-31_Zerodha_final_v2.csv
const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const rows = parseCSV(raw);

const divRows = rows.filter(r => {
  const note = String(r.Note || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  const type = String(r.InvestmentTransactionType || '').toUpperCase();
  return note.includes('dividend') || desc.includes('dividend') || type === 'DIVIDEND';
});

let sumDiv = 0;
divRows.forEach(r => {
  sumDiv += parseFloat(r.INR || r.Amount || 0);
});

console.log('=== DIVIDEND AUDIT IN V2 CSV ===');
console.log(`Total dividend records count: ${divRows.length} (Expected: 40)`);
console.log(`Total dividend sum: ₹${sumDiv.toFixed(2)} (Expected: ₹2178.55)`);

// 2. Zerodha Targets validation
const brokerConfig = [
  { name: 'Fareeda Groww', totalValue: 123003.00 }
];

const results = calculateBrokerageState(rows, brokerConfig);
const z = results['Zerodha'];
const fg = results['Fareeda Groww'];
const g = results['Groww'] || { totalPortfolioValue: 0 };
const smTotal = (z.totalPortfolioValue || 0) + (fg.totalPortfolioValue || 0) + (g.totalPortfolioValue || 0);

console.log('\n==================================================');
console.log('ZERODHA VALIDATION TARGETS');
console.log('==================================================');
console.log('Cash Balance:         ₹' + z.cashBalance.toFixed(2));
console.log('Invested Cost:        ₹' + z.investedCost.toFixed(2));
console.log('Current Value:        ₹' + z.currentMarketValue.toFixed(2));
console.log('Unrealized P&L:       ₹' + z.unrealizedPnL.toFixed(2));
console.log('Gross Realized P&L:   ₹' + z.grossRealizedPnL.toFixed(4));
console.log('Charges:             -₹' + Math.abs(z.charges).toFixed(4));
console.log('Other Credit/Debit:  -₹' + Math.abs(z.otherCreditDebit).toFixed(4));
console.log('Net Trading P&L:      ₹' + z.netTradingPnL.toFixed(4));
console.log('Total Value:          ₹' + z.totalPortfolioValue.toFixed(2));
console.log('Active Holdings:      ' + z.activeCount);
console.log('Active Securities:    ' + z.activeHoldings.map(h => `${h.symbol} (${h.qty})`).join(', '));

console.log('\n==================================================');
console.log('SHARE MARKET DYNAMIC AGGREGATION');
console.log('==================================================');
console.log('Zerodha:              ₹' + z.totalPortfolioValue.toFixed(2));
console.log('Fareeda Groww:        ₹' + fg.totalPortfolioValue.toFixed(2));
console.log('Groww:                ₹' + (g.totalPortfolioValue || 0).toFixed(2));
console.log('Share Market Total:   ₹' + smTotal.toFixed(2));

