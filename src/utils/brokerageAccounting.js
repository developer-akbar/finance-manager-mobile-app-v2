import { activeHoldingsData } from '../database/holdingsData.js';

/**
 * Parse individual transaction fields and attributes for investment transactions.
 * Prioritizes canonical investment fields and uses pipe descriptions only as fallback.
 */
export function parseTxnFields(t) {
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

/**
 * Single Authoritative Brokerage Accounting Function
 * Dynamically aggregates brokerages without hardcoding.
 */
export function calculateBrokerageState(txns = [], brokerConfigList = [], settings = {}) {
  const brokerages = new Set(brokerConfigList.map(b => b.name || b).filter(Boolean));

  txns.forEach(t => {
    const isSM = String(t.Account || t.account || '').trim() === 'Share Market' ||
      String(t.FromAccount || t.from_account || '').trim() === 'Share Market' ||
      String(t.ToAccount || t.to_account || '').trim() === 'Share Market';
    if (isSM) {
      const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
      if (sub) brokerages.add(sub);
      const f = parseTxnFields(t);
      if (f && f.brokerage) brokerages.add(f.brokerage);
    }
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
      if (!isSM) return false;
      const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
      const f = parseTxnFields(t);
      return (f && f.brokerage === broker) || (sub === broker);
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

/**
 * Deterministically resolves the investment holding account, funding/settlement bank account,
 * and platform/subaccount for an investment transaction.
 *
 * BUY:
 * - Investment Account: holding account (ToAccount / investment parent)
 * - Funding Account: bank/cash source account (FromAccount)
 * - Platform / Subaccount: SubAccount / Brokerage / ToSubAccount
 *
 * SELL:
 * - Investment Account: holding account (FromAccount / investment parent)
 * - Settlement Account: bank/cash destination account (ToAccount)
 * - Platform / Subaccount: SubAccount / Brokerage / FromSubAccount
 */
export function resolveInvestmentAccounts(t, accounts = []) {
  if (!t) return { investmentAccount: '', bankAccount: '', subAccount: '', invType: 'BUY' };

  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase() || 'BUY';

  // 1. If explicit investment account is already stored, it is authoritative!
  let explicitInvAcct = String(t.InvestmentAccount || t.investment_account || '').trim();

  const invAcctNames = new Set(
    (accounts || [])
      .filter(a => a.group?.toLowerCase() === 'investments' || ['mutual funds tax saver', 'liquid mutual funds', 'share market'].includes((a.name || '').toLowerCase()))
      .map(a => (a.name || '').toLowerCase())
  );
  if (invAcctNames.size === 0) {
    invAcctNames.add('mutual funds tax saver');
    invAcctNames.add('liquid mutual funds');
    invAcctNames.add('share market');
  }

  const toAcct = String(t.ToAccount || t.to_account || '').trim();
  const fromAcct = String(t.FromAccount || t.from_account || '').trim();
  const acct = String(t.Account || t.account || '').trim();
  const cat = String(t.Category || t.category || '').trim();

  let investmentAccount = explicitInvAcct;
  let bankAccount = ''; // fundingAccount for BUY, settlementAccount for SELL

  if (!investmentAccount) {
    if (invType === 'BUY') {
      // In BUY: ToAccount is the holding asset account
      if (toAcct && invAcctNames.has(toAcct.toLowerCase())) {
        investmentAccount = toAcct;
      } else if (acct && invAcctNames.has(acct.toLowerCase())) {
        investmentAccount = acct;
      } else if (fromAcct && invAcctNames.has(fromAcct.toLowerCase())) {
        investmentAccount = fromAcct;
      } else if (cat && invAcctNames.has(cat.toLowerCase())) {
        investmentAccount = cat;
      } else {
        investmentAccount = toAcct || acct || fromAcct || 'Liquid Mutual Funds';
      }
    } else {
      // In SELL: FromAccount is the holding asset account
      if (fromAcct && invAcctNames.has(fromAcct.toLowerCase())) {
        investmentAccount = fromAcct;
      } else if (acct && invAcctNames.has(acct.toLowerCase())) {
        investmentAccount = acct;
      } else if (toAcct && invAcctNames.has(toAcct.toLowerCase())) {
        investmentAccount = toAcct;
      } else if (cat && invAcctNames.has(cat.toLowerCase())) {
        investmentAccount = cat;
      } else {
        investmentAccount = fromAcct || acct || toAcct || 'Liquid Mutual Funds';
      }
    }
  }

  // Resolve funding/settlement bank account
  if (invType === 'BUY') {
    if (fromAcct && fromAcct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(fromAcct.toLowerCase())) {
      bankAccount = fromAcct;
    } else if (acct && acct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(acct.toLowerCase())) {
      bankAccount = acct;
    }
  } else {
    if (toAcct && toAcct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(toAcct.toLowerCase())) {
      bankAccount = toAcct;
    } else if (acct && acct.toLowerCase() !== investmentAccount.toLowerCase() && !invAcctNames.has(acct.toLowerCase())) {
      bankAccount = acct;
    }
  }

  // Exact casing match from accounts configuration
  const matchedInv = (accounts || []).find(a => (a.name || '').toLowerCase() === investmentAccount.toLowerCase());
  if (matchedInv) investmentAccount = matchedInv.name;

  const matchedBank = (accounts || []).find(a => (a.name || '').toLowerCase() === bankAccount.toLowerCase());
  if (matchedBank) bankAccount = matchedBank.name;

  const subAccount = String(
    t.SubAccount || t.sub_account ||
    (invType === 'BUY' ? (t.ToSubAccount || t.to_sub_account) : (t.FromSubAccount || t.from_sub_account)) ||
    t.Brokerage || t.brokerage ||
    t.ToSubAccount || t.to_sub_account ||
    t.FromSubAccount || t.from_sub_account || ''
  ).trim();

  return { investmentAccount, bankAccount, subAccount, invType };
}
