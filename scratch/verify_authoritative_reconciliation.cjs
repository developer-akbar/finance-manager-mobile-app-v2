const fs = require('fs');

function parseCSV(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] !== undefined ? values[idx] : '';
    });
    rows.push(obj);
  }
  return rows;
}

function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
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
    let cashImpact = parseFloat(t.CashImpact || t.cash_impact || t.INR || t.inr || t.Amount || t.amount || 0);
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
      brokerage: broker || 'Zerodha',
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
      brokerage: String(t.Brokerage || t.brokerage || '').trim(),
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
  const brokerages = new Set(brokerConfigList.map(b => b.name || b));
  brokerages.add('Zerodha');
  brokerages.add('Fareeda Groww');

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

    // Filter broker transactions
    const brokerTxns = txns.filter(t => {
      const isSM = String(t.Account || t.account || '').trim() === 'Share Market' ||
        String(t.FromAccount || t.from_account || '').trim() === 'Share Market' ||
        String(t.ToAccount || t.to_account || '').trim() === 'Share Market';
      const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
      const f = parseTxnFields(t);
      return (f && f.brokerage === broker) || (isSM && sub === broker);
    });

    // 1. Brokerage Cash Ledger (Genuine Cash Movements Only)
    let cashBalance = 0;
    let bankFunding = 0;
    let bankWithdrawals = 0;
    let genuineBuyCash = 0;
    let genuineSellCash = 0;
    let charges = 0;
    let otherCreditDebit = 0;
    let reconciliationCash = 0;

    // 2. Realized P&L & Performance
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
      } else if (f.type === 'CHARGE' || note === 'Zerodha Charges' || desc.includes('trading charges')) {
        charges += inr;
        cashBalance += inr;
      } else if (f.type === 'OTHER_CREDIT_DEBIT' || note === 'Other Credit & Debit') {
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

      // --- Performance / Realized P&L Rules ---
      if (f.type === 'REALIZED_PNL') {
        if (f.realizedPnL > 0) grossRealizedGains += f.realizedPnL;
        else grossRealizedLosses += f.realizedPnL;
      } else if (note === 'Zerodha Gains') {
        grossRealizedGains += inr;
      } else if (note === 'Zerodha Losses') {
        grossRealizedLosses += inr;
      } else if (desc.includes('Realized P&L reconciliation')) {
        if (inr > 0) grossRealizedGains += inr;
        else grossRealizedLosses += inr;
      }
    });

    const grossRealizedPnL = grossRealizedGains + grossRealizedLosses;
    const netTradingPnL = grossRealizedPnL + charges + otherCreditDebit;

    // 3. Security Positions & Cost Basis
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

    Object.values(holdings).forEach(h => {
      const isActive = h.qty > 0 && h.activeStatus !== 'NO' && h.symbol !== 'VISESHINFO-Z' && h.symbol !== 'VISESHINFO' && h.symbol !== 'TATAMTRDVR';
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

    // Preserve Fareeda Groww valuation if present in config/settings
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

const raw = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const rows = parseCSV(raw);

// Explicit reconciliation transaction
const reconciliationTxn = {
  Date: '31/08/2026',
  'Income/Expense': 'Expense',
  Account: 'Share Market',
  SubAccount: 'Zerodha',
  Category: 'Finance',
  Note: 'Historical opening cash reconciliation for pre-tradebook activity',
  INR: '-1953.02',
  Amount: '-1953.02',
  Description: 'RECONCILIATION | Broker=Zerodha | Amount=-1953.02 | Reason=Historical opening cash reconciliation for pre-tradebook activity'
};

const rowsWithReconciliation = [...rows, reconciliationTxn];
const brokerConfig = [
  { name: 'Zerodha' },
  { name: 'Fareeda Groww', totalValue: 123003.00 },
  { name: 'Groww' }
];

const results = calculateBrokerageState(rowsWithReconciliation, brokerConfig);

const z = results['Zerodha'];
const fg = results['Fareeda Groww'];
const g = results['Groww'] || { totalPortfolioValue: 0 };
const smTotal = (z.totalPortfolioValue || 0) + (fg.totalPortfolioValue || 0) + (g.totalPortfolioValue || 0);

console.log('==================================================');
console.log('ZERODHA');
console.log('==================================================');
console.log('Cash:                ₹' + z.cashBalance.toFixed(2));
console.log('Invested Cost:       ₹' + z.investedCost.toFixed(2));
console.log('Current Market Value:₹' + z.currentMarketValue.toFixed(2));
console.log('Unrealized P&L:      ₹' + z.unrealizedPnL.toFixed(2));
console.log('Gross Realized P&L:  ₹' + z.grossRealizedPnL.toFixed(4));
console.log('Charges:            -₹' + Math.abs(z.charges).toFixed(4));
console.log('Other Credit/Debit: -₹' + Math.abs(z.otherCreditDebit).toFixed(4));
console.log('Net Trading P&L:     ₹' + z.netTradingPnL.toFixed(4));
console.log('Total Portfolio Value:₹' + z.totalPortfolioValue.toFixed(2));
console.log('Active Holdings:     ' + z.activeCount);
console.log('Holdings Details:');
z.activeHoldings.forEach(h => {
  console.log(`  - ${h.symbol}: Qty=${h.qty}, Invested=₹${h.investedCost.toFixed(2)}, Current=₹${h.currentValue.toFixed(2)}`);
});

console.log('\n==================================================');
console.log('SHARE MARKET');
console.log('==================================================');
console.log('Zerodha:             ₹' + z.totalPortfolioValue.toFixed(2));
console.log('Fareeda Groww:       ₹' + fg.totalPortfolioValue.toFixed(2));
console.log('Groww:               ₹' + (g.totalPortfolioValue || 0).toFixed(2));
console.log('Share Market Total:  ₹' + smTotal.toFixed(2));
console.log('ACTIVE SECURITIES:   ' + z.activeCount);
