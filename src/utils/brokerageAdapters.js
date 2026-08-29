import { v4 as uuid } from 'uuid';

// Helper to hash string to a deterministic UUID-like string
export const hashString = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `det-${hex}-4000-8000-${hex}${hex}`;
};

export const parseExcelDate = (raw) => {
  if (typeof raw === 'number' && raw > 1000) {
    const ms = (raw - 25569) * 86400 * 1000;
    const d  = new Date(ms);
    return String(d.getUTCDate()).padStart(2,'0') + '/' +
           String(d.getUTCMonth()+1).padStart(2,'0') + '/' +
           d.getUTCFullYear();
  }
  if (raw instanceof Date) {
    return String(raw.getUTCDate()).padStart(2,'0') + '/' +
           String(raw.getUTCMonth()+1).padStart(2,'0') + '/' +
           raw.getUTCFullYear();
  }
  let s = String(raw || '').trim();
  if (!s) return '';
  // Match ISO yyyy-mm-dd
  const iso = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  // Match dd/mm/yyyy
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${String(dmy[1]).padStart(2,'0')}/${String(dmy[2]).padStart(2,'0')}/${dmy[3]}`;
  return s;
};

const parseTime = (s) => {
  if (!s) return '09:30';
  const match = String(s).match(/T(\d{2}:\d{2})/);
  if (match) return match[1];
  const match2 = String(s).match(/(\d{2}:\d{2})/);
  if (match2) return match2[1];
  return '09:30';
};

// Tradebook Parser
export const parseTradebook = (rows, brokerage = 'Zerodha') => {
  // Sort rows chronologically
  const sorted = [...rows].sort((a, b) => {
    const da = new Date(parseExcelDate(a.trade_date || a.Date || '')).getTime() || 0;
    const db = new Date(parseExcelDate(b.trade_date || b.Date || '')).getTime() || 0;
    if (da !== db) return da - db;
    const ta = parseTime(a.order_execution_time || a.Time || '');
    const tb = parseTime(b.order_execution_time || b.Time || '');
    return ta.localeCompare(tb);
  });

  const queues = {}; // symbol -> array of { qty, price }
  const txns = [];

  for (const r of sorted) {
    const symbol = String(r.symbol || r.Symbol || r.SecuritySymbol || '').trim().toUpperCase();
    if (!symbol) continue;

    const rawDate = r.trade_date || r.Date || '';
    const dateVal = parseExcelDate(rawDate);
    const timeVal = parseTime(r.order_execution_time || r.Time || '');
    const type = String(r.trade_type || r.trade_type || r.InvestmentTransactionType || '').trim().toUpperCase();
    const isBuy = type === 'BUY' || type === 'BUY_RECON' || type === 'OPENING_LOT';

    const qty = parseFloat(r.quantity || r.Quantity || 0);
    const price = parseFloat(r.price || r.UnitPrice || 0);
    const val = qty * price;

    let costBasis = 0;
    let realizedPnl = 0;

    if (isBuy) {
      if (!queues[symbol]) queues[symbol] = [];
      queues[symbol].push({ qty, price });
      costBasis = val;
      realizedPnl = 0;
    } else {
      // FIFO Sell cost basis calculation
      let remainingToSell = qty;
      let costSum = 0;
      const q = queues[symbol] || [];

      while (remainingToSell > 0 && q.length > 0) {
        const lot = q[0];
        if (lot.qty <= remainingToSell) {
          costSum += lot.qty * lot.price;
          remainingToSell -= lot.qty;
          q.shift();
        } else {
          costSum += remainingToSell * lot.price;
          lot.qty -= remainingToSell;
          remainingToSell = 0;
        }
      }

      // Fallback for missing historical buys: assume cost = sale price (no artificial P&L)
      if (remainingToSell > 0) {
        costSum += remainingToSell * price;
      }

      costBasis = costSum;
      realizedPnl = val - costBasis;
    }

    const tradeId = String(r.trade_id || r.TradeId || '');
    const orderId = String(r.order_id || r.OrderId || '');
    const stableKey = `${brokerage}|${symbol}|${dateVal}|${timeVal}|${type}|${qty}|${price}|${tradeId}|${orderId}`;
    const id = r.ID || r.id || hashString(stableKey);

    txns.push({
      ID: id,
      Date: dateVal,
      Time: timeVal,
      Account: 'Share Market',
      FromAccount: 'Share Market',
      ToAccount: 'Share Market',
      Category: type,
      Subcategory: symbol,
      Note: symbol,
      Description: `${type} | Broker=${brokerage} | Symbol=${symbol} | Qty=${qty} | Price=${price.toFixed(4)} | Proceeds=${val.toFixed(4)} | CostBasis=${costBasis.toFixed(4)} | RealizedPL=${realizedPnl.toFixed(4)}`,
      INR: val,
      Amount: String(val),
      Currency: 'INR',
      'Income/Expense': 'Transfer-Out',
      Tags: `${brokerage}|StockTrade|${type}`,
      FromSubAccount: brokerage,
      ToSubAccount: brokerage,
      InvestmentTransactionType: type,
      Brokerage: brokerage,
      SecuritySymbol: symbol,
      SecurityISIN: String(r.isin || r.SecurityISIN || ''),
      Quantity: qty,
      UnitPrice: price,
      TradeValue: val,
      CostBasis: costBasis,
      CashImpact: isBuy ? -val : val,
      PositionQuantityChange: isBuy ? qty : -qty,
      RealizedPnl: realizedPnl,
      TradeId: tradeId,
      OrderId: orderId,
      Exchange: String(r.exchange || r.Exchange || 'NSE'),
      Segment: String(r.segment || r.Segment || 'EQ'),
      Source: `${brokerage} Tradebook`
    });

    // If realized P&L is non-zero, we also create a separate REALIZED_PNL reporting row
    if (!isBuy && Math.abs(realizedPnl) > 0.0001) {
      const isLoss = realizedPnl < 0;
      const pnlId = hashString(id + '-pnl');
      txns.push({
        ID: pnlId,
        Date: dateVal,
        Time: timeVal,
        Account: 'Share Market',
        Category: 'Equity',
        Subcategory: isLoss ? `${brokerage} Losses` : `${brokerage} Gains`,
        Note: isLoss ? `${brokerage} Losses` : `${brokerage} Gains`,
        Description: `Realized ${isLoss ? 'loss' : 'profit'} on sale of ${symbol}`,
        INR: realizedPnl,
        Amount: String(realizedPnl),
        Currency: 'INR',
        'Income/Expense': 'Income',
        Tags: `${brokerage}|RealizedPL`,
        SubAccount: brokerage,
        InvestmentTransactionType: 'REALIZED_PNL',
        Brokerage: brokerage,
        SecuritySymbol: symbol,
        Quantity: 0,
        UnitPrice: 0,
        TradeValue: 0,
        CostBasis: 0,
        CashImpact: 0,
        PositionQuantityChange: 0,
        RealizedPnl: realizedPnl,
        Source: `${brokerage} Tradebook/Calculated`
      });
    }
  }

  return txns;
};

// Ledger Parser
export const parseLedger = (rows, brokerage = 'Zerodha', bankAccount = 'HDFC') => {
  const txns = [];

  for (const r of rows) {
    const particular = String(r.particulars || r.particular || r.Particulars || r.Note || '').trim();
    if (!particular || particular.toLowerCase() === 'opening balance') continue;

    // Skip NSE settlement book vouchers to avoid double-counting cash movement (which Tradebook handles)
    if (particular.toLowerCase().includes('settlement value') || String(r.voucher_type).toLowerCase() === 'book voucher') {
      continue;
    }

    const rawDate = r.posting_date || r.date || r.Date || '';
    const dateVal = parseExcelDate(rawDate);
    if (!dateVal) continue;

    const debit = parseFloat(r.debit || r.Debit || 0);
    const credit = parseFloat(r.credit || r.Credit || 0);
    if (debit === 0 && credit === 0) continue;

    let type = 'OTHER_CREDIT_DEBIT';
    let cashImpact = 0;
    let inrVal = 0;
    let incomeExpense = 'Expense';
    let fromAccount = 'Share Market';
    let toAccount = 'Share Market';
    let fromSub = brokerage;
    let toSub = brokerage;
    let category = 'Others';

    if (debit > 0) {
      cashImpact = -debit;
      inrVal = -debit;
      if (particular.toLowerCase().includes('charges') || particular.toLowerCase().includes('charge') || particular.toLowerCase().includes('stamp duty') || particular.toLowerCase().includes('tax') || particular.toLowerCase().includes('call and trade')) {
        type = 'CHARGE';
        category = 'Investment Charges';
      } else if (particular.toLowerCase().includes('withdrawal') || particular.toLowerCase().includes('payout') || particular.toLowerCase().includes('payment to client')) {
        type = 'WITHDRAWAL';
        incomeExpense = 'Transfer-Out';
        fromAccount = 'Share Market';
        fromSub = brokerage;
        toAccount = bankAccount;
        toSub = '';
        inrVal = debit;
      }
    } else if (credit > 0) {
      cashImpact = credit;
      inrVal = credit;
      if (particular.toLowerCase().includes('payment gateway') || particular.toLowerCase().includes('nest') || particular.toLowerCase().includes('received') || particular.toLowerCase().includes('receipt')) {
        type = 'FUNDING';
        incomeExpense = 'Transfer-Out';
        fromAccount = bankAccount;
        fromSub = '';
        toAccount = 'Share Market';
        toSub = brokerage;
      } else {
        incomeExpense = 'Income';
        category = 'Investment Returns';
      }
    }

    const stableKey = `${brokerage}|ledger|${particular}|${dateVal}|${debit}|${credit}`;
    const id = r.ID || r.id || hashString(stableKey);

    txns.push({
      ID: id,
      Date: dateVal,
      Time: '09:00',
      Account: type === 'FUNDING' ? bankAccount : 'Share Market',
      FromAccount: fromAccount,
      ToAccount: toAccount,
      Category: incomeExpense === 'Transfer-Out' ? toAccount : category,
      Subcategory: brokerage,
      Note: particular,
      Description: particular,
      INR: inrVal,
      Amount: String(Math.abs(inrVal)),
      Currency: 'INR',
      'Income/Expense': incomeExpense,
      Tags: `${brokerage}|Ledger|${type}`,
      SubAccount: incomeExpense === 'Transfer-Out' ? '' : brokerage,
      FromSubAccount: fromSub,
      ToSubAccount: toSub,
      InvestmentTransactionType: type,
      Brokerage: brokerage,
      Quantity: 0,
      UnitPrice: 0,
      TradeValue: Math.abs(inrVal),
      CostBasis: 0,
      CashImpact: cashImpact,
      PositionQuantityChange: 0,
      RealizedPnl: 0,
      Source: `${brokerage} Ledger`
    });
  }

  return txns;
};

// Holdings parser (updates price cache)
export const parseHoldings = (rows) => {
  const prices = {};

  for (const r of rows) {
    const symbol = String(r.symbol || r.Symbol || r.SecuritySymbol || '').trim().toUpperCase();
    if (!symbol) continue;

    const currentPrice = parseFloat(r.market_price || r.CurrentPrice || r.price || r.last_price || r.ltp || r.LTP || 0);
    if (currentPrice > 0) {
      prices[symbol] = currentPrice;
    }
  }

  return prices;
};

// Dividend parser
export const parseDividends = (rows, brokerage = 'Zerodha', bankAccount = 'HDFC') => {
  const txns = [];

  for (const r of rows) {
    const symbol = String(r.security || r.Security || r.symbol || r.Symbol || '').trim().toUpperCase();
    if (!symbol) continue;

    const rawDate = r.date || r.Date || r.posting_date || '';
    const dateVal = parseExcelDate(rawDate);
    if (!dateVal) continue;

    const amount = parseFloat(r.amount || r.Amount || r.inr || r.INR || 0);
    if (amount <= 0) continue;

    const stableKey = `${brokerage}|dividend|${symbol}|${dateVal}|${amount}`;
    const id = r.ID || r.id || hashString(stableKey);

    txns.push({
      id,
      Date: dateVal,
      Time: '12:00',
      Account: bankAccount,
      FromAccount: bankAccount,
      ToAccount: '',
      Category: 'Investment Returns',
      Subcategory: 'Dividends',
      Note: symbol,
      Description: `Dividend received from ${symbol} via ${brokerage}`,
      INR: amount,
      Amount: String(amount),
      Currency: 'INR',
      'Income/Expense': 'Income',
      Tags: `${brokerage}|Dividend`,
      SubAccount: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  return txns;
};
