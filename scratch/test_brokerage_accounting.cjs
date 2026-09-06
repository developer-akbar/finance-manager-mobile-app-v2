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
  const desc = String(t.Description || '').trim();
  const type = String(t.InvestmentTransactionType || '').trim();
  const isShareMarketTxn = 
    String(t.Account || '').trim() === 'Share Market' ||
    String(t.FromAccount || '').trim() === 'Share Market' ||
    String(t.ToAccount || '').trim() === 'Share Market' ||
    !!(t.Brokerage || t.brokerage);

  if (type) {
    return {
      type,
      brokerage: String(t.Brokerage || '').trim(),
      symbol: String(t.SecuritySymbol || t.Note || '').trim().toUpperCase(),
      qty: parseFloat(t.Quantity || 0),
      cost: parseFloat(t.TradeValue || 0),
      costBasis: parseFloat(t.CostBasis || 0),
      cashImpact: parseFloat(t.CashImpact || 0),
      realizedPnL: parseFloat(t.RealizedPnl || 0),
      activeHolding: desc.includes('ActiveHolding=NO') || String(t.Note || '').includes('ActiveHolding=NO') ? 'NO' : 'YES',
      isRecon: desc.includes('EntryDate=UNKNOWN') || desc.includes('historical position closure') || desc.includes('Source=CurrentP&L')
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
      
      const broker = fields.Broker || (isShareMarketTxn ? String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim() : '');
      const symbol = fields.Symbol || String(t.Note || '').trim().toUpperCase();
      const qty = parseFloat(fields.Qty || fields.Quantity || 0);
      const cost = parseFloat(fields.Cost || fields.CostBasis || fields.TradeValue || (fields.Price ? qty * parseFloat(fields.Price) : 0) || 0);
      const costBasis = parseFloat(fields.CostBasis || 0);
      const realizedPnL = parseFloat(fields.RealizedPL || fields.RealizedPnL || 0);
      const activeHolding = fields.ActiveHolding || (desc.includes('ActiveHolding=NO') ? 'NO' : 'YES');
      const isRecon = parsedType === 'BUY_RECON' || desc.includes('EntryDate=UNKNOWN') || desc.includes('historical position closure') || desc.includes('Source=CurrentP&L');
      
      return {
        type: parsedType,
        brokerage: broker,
        symbol,
        qty,
        cost,
        costBasis,
        cashImpact: isRecon ? 0 : parseFloat(t.INR || t.Amount || 0),
        realizedPnL,
        activeHolding,
        isRecon
      };
    }
  }
  
  const broker = isShareMarketTxn ? String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim() : '';
  const symbol = isShareMarketTxn ? String(t.Note || '').trim().toUpperCase() : '';
  const isRecon = desc.includes('reconciliation') || desc.includes('BUY_RECON') || desc.includes('EntryDate=UNKNOWN');

  return {
    type: String(t.InvestmentTransactionType || t.Category || '').trim(),
    brokerage: broker,
    symbol,
    qty: 0,
    cost: 0,
    costBasis: 0,
    cashImpact: isRecon ? 0 : parseFloat(t.INR || t.Amount || 0),
    realizedPnL: 0,
    activeHolding: 'YES',
    isRecon
  };
}

function calculateBrokerageState(txns, brokerConfigList = [], settings = {}) {
  const brokerages = new Set(brokerConfigList.map(b => b.name));
  txns.forEach(t => {
    const f = parseTxnFields(t);
    if (f.brokerage) brokerages.add(f.brokerage);
    const sub = String(t.SubAccount || t.FromSubAccount || t.ToSubAccount || '').trim();
    if (sub) brokerages.add(sub);
  });

  const results = {};
  let holdingsPrices = {};
  try {
    holdingsPrices = JSON.parse(settings.holdings_prices || '{}');
  } catch {}

  brokerages.forEach(broker => {
    if (!broker || broker === 'Share Market') return;

    // 1. Filter broker transactions
    const brokerTxns = txns.filter(t => {
      const f = parseTxnFields(t);
      const sub = String(t.SubAccount || t.FromSubAccount || t.ToSubAccount || '').trim();
      return f.brokerage === broker || sub === broker;
    });

    // 2. Compute Brokerage Cash Ledger (Genuine Cash Movements Only)
    let cashBalance = 0;
    let bankFunding = 0;
    let bankWithdrawals = 0;
    let genuineBuyCash = 0;
    let genuineSellCash = 0;
    let charges = 0;
    let otherCreditDebit = 0;
    let reconciliationCash = 0;

    // 3. Compute Realized P&L & Performance
    let grossRealizedGains = 0;
    let grossRealizedLosses = 0;

    brokerTxns.forEach(t => {
      const f = parseTxnFields(t);
      const desc = String(t.Description || '').trim();
      const note = String(t.Note || '').trim();
      const type = String(t['Income/Expense'] || '').trim();
      const acct = String(t.Account || t.FromAccount || '').trim();
      const dest = String(t.ToAccount || '').trim();
      const inr = parseFloat(t.INR || t.Amount || 0);

      // --- Cash Ledger Rules ---
      if (f.type === 'RECONCILIATION' || desc.startsWith('RECONCILIATION')) {
        reconciliationCash += inr;
        cashBalance += inr;
      } else if (f.type === 'BUY' && !f.isRecon) {
        // Genuine Buy Cash Impact
        genuineBuyCash += inr;
        cashBalance -= inr;
      } else if (f.type === 'SELL') {
        // Genuine Sell Cash Impact
        genuineSellCash += inr;
        cashBalance += inr;
      } else if (f.type === 'CHARGE' || note === 'Zerodha Charges' || desc.includes('trading charges')) {
        // Charges (INR is negative)
        charges += inr;
        cashBalance += inr;
      } else if (f.type === 'OTHER_CREDIT_DEBIT' || note === 'Other Credit & Debit') {
        // Other Credit / Debit (INR is negative/positive)
        otherCreditDebit += inr;
        cashBalance += inr;
      } else if (type === 'Transfer-Out') {
        // Bank Funding & Withdrawals
        if (acct !== 'Share Market' && dest === 'Share Market') {
          bankFunding += inr;
          cashBalance += inr;
        } else if (acct === 'Share Market' && dest !== 'Share Market') {
          bankWithdrawals += inr;
          cashBalance -= inr;
        }
        // Share Market -> Share Market transfers are internal, no net impact
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

    // 4. Compute Security Positions & Cost Basis
    const holdings = {};
    brokerTxns.forEach(t => {
      const f = parseTxnFields(t);
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
      }
    });

    const unrealizedPnL = currentMarketValue - investedCost;
    const totalPortfolioValue = cashBalance + currentMarketValue;

    results[broker] = {
      broker,
      cashBalance,
      bankFunding,
      bankWithdrawals,
      genuineBuyCash,
      genuineSellCash,
      charges,
      otherCreditDebit,
      reconciliationCash,
      investedCost,
      currentMarketValue,
      totalPortfolioValue,
      unrealizedPnL,
      grossRealizedGains,
      grossRealizedLosses,
      grossRealizedPnL,
      netTradingPnL,
      activeHoldings
    };
  });

  return results;
}

const raw = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const rows = parseCSV(raw);

const state = calculateBrokerageState(rows);
console.log('=== CALCULATE BROKERAGE STATE RESULT ===');
console.log(JSON.stringify(state, null, 2));

