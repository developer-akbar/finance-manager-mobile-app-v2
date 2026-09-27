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
  const acct = String(t.Account || t.account || t.FromAccount || t.from_account || '').replace(/\r\n/g, '\n').trim().toLowerCase();
  const cat = String(t.Category || t.category || '').replace(/\r\n/g, '\n').trim().toLowerCase();
  const subcat = String(t.Subcategory || t.subcategory || '').replace(/\r\n/g, '\n').trim().toLowerCase();
  const note = String(t.Note || t.note || '').replace(/\r\n/g, '\n').trim().toLowerCase();

  return `txn_biz:${date}|${inr}|${type}|${acct}|${cat}|${subcat}|${note}`;
}

/**
 * Deterministic business fingerprint for investment transactions
 */
export function getInvestmentTransactionBusinessKey(t) {
  if (!t || typeof t !== 'object') return '';

  const date = normalizeDateForIdentity(t.Date || t.date || '');
  // Deterministic ISIN precedence with clean symbol fallback
  const sec = String(t.SecurityISIN || t.security_isin || t.SecuritySymbol || t.security_symbol || '').trim().toUpperCase();
  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || t['Income/Expense'] || t.type || '').trim().toUpperCase();
  const qty = parseFloat(t.Quantity ?? t.quantity ?? 0).toFixed(4);
  const unitPrice = parseFloat(t.UnitPrice ?? t.unit_price ?? 0).toFixed(4);
  const tradeVal = parseFloat(t.TradeValue ?? t.trade_value ?? t.INR ?? t.inr ?? t.Amount ?? t.amount ?? 0).toFixed(2);

  return `inv_biz:${date}|${sec}|${invType}|${qty}|${unitPrice}|${tradeVal}`;
}

/**
 * Get appropriate business key for any financial transaction record
 */
export function getEntityBusinessKey(entity, entityType) {
  if (!entity || typeof entity !== 'object') return null;

  if (entityType === 'transaction' || entityType === 'transactions') {
    return getTransactionBusinessKey(entity);
  }

  if (entityType === 'investment_transaction' || entityType === 'investment_transactions') {
    return getInvestmentTransactionBusinessKey(entity);
  }

  // Non-financial entities do NOT use business-key matching
  return null;
}
