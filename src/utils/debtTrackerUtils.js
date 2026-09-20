/**
 * debtTrackerUtils.js
 *
 * Authoritative utility functions for Debt & Lending Tracker:
 * - Strict person-scope extraction from transaction notes
 * - Exclusion of non-person internal clearings, platform accounts, and trip memos
 */

export function extractPersonName(rawNote) {
  if (!rawNote) return null;
  let s = rawNote.trim();

  // Must match standard directional person prefix in note
  const match = s.match(/^(to\s*:?|from\s*:?|lend\s*to\s*:?|lend\s*from\s*:?|borrow\s*from\s*:?|given\s*to\s*:?|received\s*from\s*:?|return\s*from\s*:?|repay\s*to\s*:?|paid\s*to\s*:?)\s+(.+)$/i);
  if (!match) return null;

  let name = match[2].trim();
  // Strip trailing notes/numbers like "(1/3)", "repayment", "loan", "advance", etc.
  name = name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  name = name.replace(/\s+(return|settlement|repayment|lent|borrowed|advance|loan|dues?|clearing|alignment|share)$/i, '').trim();
  if (!name) return null;

  const lower = name.toLowerCase();

  // Exclude non-person targets: accounts, platforms, asset classes, clearing phrases, locations, generic terms
  const nonPersonTokens = [
    'share market', 'sharemarket', 'market', 'stock', 'mutual fund', 'bank', 'capital',
    'drawer', 'clearing', 'alignment', 'replenishment', 'adjustment', 'settlement',
    'goa', 'vellore', 'ooty', 'trip', 'hospital', 'food', 'transportation', 'hotel', 'flight',
    'house', 'rent', 'office', 'gplay', 'google play', 'amazon', 'flipkart', 'paytm', 'cash',
    'family members', 'self', 'internal', 'for adjustment', 'refund', 'recover'
  ];

  if (nonPersonTokens.some(token => lower === token || lower.startsWith(token + ' ') || lower.endsWith(' ' + token))) {
    return null;
  }

  return name.charAt(0).toUpperCase() + name.slice(1);
}
