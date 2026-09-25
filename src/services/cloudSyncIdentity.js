/**
 * cloudSyncIdentity.js — Deterministic Business-Identity Reconciliation Layer
 * 
 * Provides deterministic business fingerprints for financial transactions when primary IDs
 * differ due to historical bulk imports or ID migrations.
 * 
 * Primary ID remains the physical canonical record key.
 * Business identity is used ONLY for cross-device reconciliation when primary IDs differ.
 */

/**
 * Normalise a date string to canonical DD/MM/YYYY format
 */
export function normalizeDateForIdentity(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) {
    const d = String(dmy[1]).padStart(2, '0');
    const m = String(dmy[2]).padStart(2, '0');
    const y = dmy[3];
    return `${d}/${m}/${y}`;
  }
  const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (ymd) {
    const y = ymd[1];
    const m = String(ymd[2]).padStart(2, '0');
    const d = String(ymd[3]).padStart(2, '0');
    return `${d}/${m}/${y}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const dObj = new Date(s);
    if (!isNaN(dObj.getTime())) {
      const d = String(dObj.getUTCDate()).padStart(2, '0');
      const m = String(dObj.getUTCMonth() + 1).padStart(2, '0');
      const y = String(dObj.getUTCFullYear());
      return `${d}/${m}/${y}`;
    }
  }
  return s;
}

/**
 * Normalise transaction type string
 */
export function normalizeTypeForIdentity(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('inc') || s === 'income') return 'income';
  if (s.startsWith('exp') || s === 'expense') return 'expense';
  if (s.includes('transfer-in')) return 'transfer-in';
  if (s.includes('transfer-out')) return 'transfer-out';
  if (s.includes('transfer')) return 'transfer-out';
  return s;
}

/**
 * Deterministic business fingerprint for ordinary transactions
 */
export function getTransactionBusinessKey(t) {
  if (!t || typeof t !== 'object') return '';

  const date = normalizeDateForIdentity(t.Date || t.date || '');
  const inr = parseFloat(t.INR ?? t.inr ?? t.Amount ?? t.amount ?? 0).toFixed(2);
  const type = normalizeTypeForIdentity(t['Income/Expense'] || t.type || '');
  const acct = String(t.Account || t.account || '').trim().toLowerCase();
  const fromAcct = String(t.FromAccount || t.from_account || '').trim().toLowerCase();
  const toAcct = String(t.ToAccount || t.to_account || '').trim().toLowerCase();
  const cat = String(t.Category || t.category || '').trim().toLowerCase();
  const subcat = String(t.Subcategory || t.subcategory || '').trim().toLowerCase();
  const note = String(t.Note || t.note || '').trim().toLowerCase();
  const desc = String(t.Description || t.description || '').trim().toLowerCase();
  const tags = String(t.Tags || t.tags || '').trim().toLowerCase();
  const subAcct = String(t.SubAccount || t.sub_account || '').trim().toLowerCase();
  const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim().toLowerCase();
  const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim().toLowerCase();

  return `txn_biz:${date}|${inr}|${type}|${acct}|${fromAcct}|${toAcct}|${cat}|${subcat}|${note}|${desc}|${tags}|${subAcct}|${fromSub}|${toSub}`;
}

/**
 * Deterministic business fingerprint for investment transactions
 */
export function getInvestmentTransactionBusinessKey(t) {
  if (!t || typeof t !== 'object') return '';

  const date = normalizeDateForIdentity(t.Date || t.date || '');
  const symbol = String(t.SecuritySymbol || t.security_symbol || '').trim().toUpperCase();
  const isin = String(t.SecurityISIN || t.security_isin || '').trim().toUpperCase();
  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || t['Income/Expense'] || t.type || '').trim().toUpperCase();
  const qty = parseFloat(t.Quantity ?? t.quantity ?? 0).toFixed(4);
  const unitPrice = parseFloat(t.UnitPrice ?? t.unit_price ?? 0).toFixed(4);
  const tradeVal = parseFloat(t.TradeValue ?? t.trade_value ?? t.INR ?? t.inr ?? t.Amount ?? t.amount ?? 0).toFixed(2);
  const costBasis = parseFloat(t.CostBasis ?? t.cost_basis ?? 0).toFixed(2);
  const cashImpact = parseFloat(t.CashImpact ?? t.cash_impact ?? 0).toFixed(2);
  const tradeId = String(t.TradeId || t.trade_id || '').trim();
  const orderId = String(t.OrderId || t.order_id || '').trim();
  const source = String(t.Source || t.source || '').trim().toLowerCase();
  const brokerage = String(t.Brokerage || t.brokerage || '').trim().toLowerCase();
  const subAcct = String(t.SubAccount || t.sub_account || '').trim().toLowerCase();

  return `inv_biz:${date}|${symbol}|${isin}|${invType}|${qty}|${unitPrice}|${tradeVal}|${costBasis}|${cashImpact}|${tradeId}|${orderId}|${source}|${brokerage}|${subAcct}`;
}

/**
 * Get appropriate business key for any financial transaction record
 */
export function getEntityBusinessKey(entity, entityType) {
  if (!entity || typeof entity !== 'object') return null;
  const isInv = entityType === 'investment_transaction' ||
                entityType === 'investment_transactions' ||
                Boolean(entity.InvestmentTransactionType || entity.investment_transaction_type || entity.Brokerage || entity.brokerage || entity.SecuritySymbol || entity.security_symbol);

  if (isInv) {
    return getInvestmentTransactionBusinessKey(entity);
  }

  if (entityType === 'transaction' || entityType === 'transactions') {
    return getTransactionBusinessKey(entity);
  }

  // Non-financial entities do NOT use business-key matching
  return null;
}
