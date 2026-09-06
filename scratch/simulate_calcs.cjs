const fs = require('fs');
const path = require('path');

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

const raw = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const rows = parseCSV(raw);

function txnAmount(t) {
  return parseFloat(t.INR || t.Amount || t.amount || 0);
}

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
      activeHolding: desc.includes('ActiveHolding=NO') || String(t.Note || '').includes('ActiveHolding=NO') ? 'NO' : 'YES'
    };
  }
  
  const investmentTypes = new Set(['BUY', 'SELL', 'OPENING_LOT', 'BONUS', 'POSITION_STATUS', 'REALIZED_PNL', 'CHARGE', 'OTHER_CREDIT_DEBIT', 'FUNDING', 'WITHDRAWAL', 'DIVIDEND']);
  
  if (desc.includes('|')) {
    const parts = desc.split('|').map(p => p.trim());
    const parsedType = parts[0];
    if (investmentTypes.has(parsedType)) {
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
      
      return {
        type: parsedType,
        brokerage: broker,
        symbol,
        qty,
        cost,
        costBasis,
        cashImpact: parseFloat(t.INR || t.Amount || 0),
        realizedPnL,
        activeHolding
      };
    }
  }
  
  const broker = isShareMarketTxn ? String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim() : '';
  const symbol = isShareMarketTxn ? String(t.Note || '').trim().toUpperCase() : '';
  return {
    type: String(t.InvestmentTransactionType || t.Category || '').trim(),
    brokerage: broker,
    symbol,
    qty: 0,
    cost: 0,
    costBasis: 0,
    cashImpact: parseFloat(t.INR || t.Amount || 0),
    realizedPnL: 0,
    activeHolding: 'YES'
  };
}

// 1. Build standard ledger balance for Share Market / Zerodha
let rawShareMarketBalance = 0;
let rawShareMarketZerodhaBalance = 0;

rows.forEach(t => {
  const amt = txnAmount(t);
  const type = String(t['Income/Expense'] || '').trim();
  const acct = String(t.Account || t.FromAccount || '').trim();
  const dest = String(t.ToAccount || '').trim();
  const sub = String(t.SubAccount || t.FromSubAccount || '').trim();
  const toSub = String(t.ToSubAccount || '').trim();

  if (type === 'Income') {
    if (acct === 'Share Market') {
      rawShareMarketBalance += amt;
      if (sub === 'Zerodha') rawShareMarketZerodhaBalance += amt;
    }
  } else if (type === 'Expense') {
    if (acct === 'Share Market') {
      rawShareMarketBalance -= amt;
      if (sub === 'Zerodha') rawShareMarketZerodhaBalance -= amt;
    }
  } else if (type === 'Transfer-Out') {
    if (acct === 'Share Market') {
      rawShareMarketBalance -= amt;
      if (sub === 'Zerodha') rawShareMarketZerodhaBalance -= amt;
    }
    if (dest === 'Share Market') {
      rawShareMarketBalance += amt;
      if (toSub === 'Zerodha') rawShareMarketZerodhaBalance += amt;
    }
  }
});

console.log('Raw ledger Share Market balance (buildBalanceMap):', rawShareMarketBalance);
console.log('Raw ledger Share Market > Zerodha balance (buildSubAccountBalanceMap):', rawShareMarketZerodhaBalance);

// Let's trace standardSum in calculateShareMarketBalances for Zerodha
const brokerTxns = rows.filter(t => {
  const f = parseTxnFields(t);
  return f.brokerage === 'Zerodha';
});

let standardSum = 0;
const standardSumItems = {};

brokerTxns.forEach(t => {
  const f = parseTxnFields(t);
  const isTrade = f.type === 'BUY' || f.type === 'SELL' || f.type === 'OPENING_LOT' || f.type === 'BONUS' || f.type === 'REALIZED_PNL';
  if (!isTrade) {
    const amt = parseFloat(t.INR || t.Amount || 0);
    const txnType = String(t['Income/Expense'] || '').trim();
    const isFrom = (String(t.FromAccount || '').trim() === 'Share Market' && String(t.FromSubAccount || '').trim() === 'Zerodha');
    const isTo = (String(t.ToAccount || '').trim() === 'Share Market' && String(t.ToSubAccount || '').trim() === 'Zerodha');
    const isAcct = (String(t.Account || '').trim() === 'Share Market' && String(t.SubAccount || '').trim() === 'Zerodha');

    const descKey = `${txnType} | ${t.Category} | ${t.Note}`;
    
    if (txnType === 'Income') {
      if (isAcct) {
        standardSum += amt;
        standardSumItems[descKey] = (standardSumItems[descKey] || 0) + amt;
      }
    } else if (txnType === 'Expense') {
      if (isAcct) {
        standardSum -= amt;
        standardSumItems[descKey] = (standardSumItems[descKey] || 0) - amt;
      }
    } else if (txnType === 'Transfer-Out') {
      if (isFrom && isTo) {
        // internal
      } else if (isFrom) {
        standardSum -= amt;
        standardSumItems[descKey] = (standardSumItems[descKey] || 0) - amt;
      } else if (isTo) {
        standardSum += amt;
        standardSumItems[descKey] = (standardSumItems[descKey] || 0) + amt;
      }
    }
  }
});

console.log('standardSum in calculateShareMarketBalances for Zerodha:', standardSum);
console.log('standardSum items breakdown:', standardSumItems);

// Now let's calculate holdings, investedCost, currentValue for Zerodha
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

const holdings = {};
brokerTxns.forEach(t => {
  const f = parseTxnFields(t);
  const isTrade = f.type === 'BUY' || f.type === 'SELL' || f.type === 'OPENING_LOT' || f.type === 'BONUS';
  if (isTrade) {
    if (f.symbol) {
      if (!holdings[f.symbol]) {
        holdings[f.symbol] = { symbol: f.symbol, qty: 0, buyCost: 0, soldCostBasis: 0, activeStatus: null };
      }
      const h = holdings[f.symbol];
      if (f.type === 'BUY' || f.type === 'OPENING_LOT' || f.type === 'BONUS') {
        h.qty += f.qty;
        h.buyCost += f.cost;
      } else if (f.type === 'SELL') {
        h.qty -= f.qty;
        h.soldCostBasis += f.costBasis;
      }
    }
  } else if (f.type === 'POSITION_STATUS') {
    if (f.symbol) {
      if (!holdings[f.symbol]) {
        holdings[f.symbol] = { symbol: f.symbol, qty: 0, buyCost: 0, soldCostBasis: 0, activeStatus: null };
      }
      if (f.activeHolding === 'NO') {
        holdings[f.symbol].activeStatus = 'NO';
      }
    }
  }
});

let investedCost = 0;
let currentValue = 0;
const activeHoldings = [];

Object.values(holdings).forEach(h => {
  const isActive = h.qty > 0 && h.activeStatus !== 'NO' && h.symbol !== 'VISESHINFO-Z' && h.symbol !== 'VISESHINFO';
  if (isActive) {
    const cost = h.buyCost - h.soldCostBasis;
    investedCost += cost;
    
    let price = 0;
    const dbHold = activeHoldingsData[h.symbol];
    if (dbHold) {
      price = dbHold.currentValue / dbHold.quantity;
    } else {
      price = cost / h.qty;
    }

    const value = h.qty * price;
    currentValue += value;

    activeHoldings.push({
      symbol: h.symbol,
      qty: h.qty,
      investedCost: cost,
      currentValue: value
    });
  }
});

const cash = standardSum - investedCost;
const totalValue = cash + currentValue;
const unrealizedGain = currentValue - investedCost;

console.log('\n=== Zerodha Portfolio Numbers ===');
console.log('standardSum:', standardSum);
console.log('investedCost:', investedCost);
console.log('currentValue:', currentValue);
console.log('unrealizedGain:', unrealizedGain);
console.log('cash (standardSum - investedCost):', cash);
console.log('totalValue (cash + currentValue):', totalValue);
console.log('activeHoldings:', activeHoldings);

