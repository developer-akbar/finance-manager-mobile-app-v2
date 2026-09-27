/**
 * canonicalEntity.js — Canonical FinMan Entity Representation & SHA-256 Fingerprint Engine
 * Version: Canonicalization Scheme v1 (RFC 8785 / JCS compliant)
 * 
 * Provides deterministic, cross-platform entity canonicalization and SHA-256 hashing.
 * Identical entities on Web (IndexedDB) and Android (SQLite) produce identical 64-char hex digests.
 */

export const CANONICALIZATION_VERSION = 1;

// Ephemeral UI and transient properties that must never pollute distributed checksums
const EXCLUDED_EPHEMERAL_KEYS = new Set([
  '_ui_selected',
  '_expanded',
  '_cached_display',
  '_highlighted',
  '_temp_id',
  '_is_loading',
  '_error',
  'ID',   // Alias of id
  '_id',  // Alias of id
]);

// Fields categorized as 2-decimal monetary currency amounts
const MONETARY_FIELDS = new Set([
  'inr',
  'actual_amount',
  'total_charges',
  'brokerage_charges',
  'exchange_charges',
  'stt_charges',
  'sebi_charges',
  'stamp_duty_charges',
  'gst_charges',
  'dp_charges',
  'other_charges',
  'planned_amount',
  'cost_basis',
  'trade_value',
  'cash_impact',
  'realized_pnl',
  'price',
  'discounted_price',
  'discount_value',
]);

// Fields categorized as 6-decimal floating-point quantities
const QUANTITY_FIELDS = new Set([
  'quantity',
  'unit_price',
  'position_qty_change',
  'qty',
  'original_qty',
  'sub_qty',
  'pack_qty',
]);

/**
 * Normalizes numbers according to FinMan canonical precision rules.
 */
function normalizeNumber(val, key = '') {
  if (typeof val !== 'number') {
    if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val))) {
      val = Number(val);
    } else {
      return 0;
    }
  }
  if (!isFinite(val) || isNaN(val)) return 0;

  const lowerKey = String(key).toLowerCase();
  let normalized;
  if (MONETARY_FIELDS.has(lowerKey)) {
    normalized = Math.round((val + Number.EPSILON) * 100) / 100;
  } else if (QUANTITY_FIELDS.has(lowerKey)) {
    normalized = Math.round((val + Number.EPSILON) * 1e6) / 1e6;
  } else {
    // Standard floating point normalization to max 6 decimals
    normalized = Math.round((val + Number.EPSILON) * 1e6) / 1e6;
  }

  // Eliminate negative zero (-0 -> 0)
  return Object.is(normalized, -0) ? 0 : normalized;
}

/**
 * Recursively canonicalizes any JS value into a deterministic JCS-compliant structure.
 */
export function canonicalizeValue(val, key = '') {
  if (val === null || val === undefined) {
    return null;
  }

  if (typeof val === 'number') {
    return normalizeNumber(val, key);
  }

  if (typeof val === 'boolean') {
    return val;
  }

  if (typeof val === 'string') {
    // Unicode NFC normalization
    return val.normalize('NFC');
  }

  if (Array.isArray(val)) {
    return val.map(item => canonicalizeValue(item));
  }

  if (typeof val === 'object') {
    const sortedObj = {};
    const keys = Object.keys(val).sort();

    for (const k of keys) {
      if (EXCLUDED_EPHEMERAL_KEYS.has(k)) continue;
      const childVal = val[k];
      if (childVal === undefined) continue; // Omit undefined keys

      sortedObj[k] = canonicalizeValue(childVal, k);
    }
    return sortedObj;
  }

  return String(val);
}

/**
 * Returns a canonical, deterministic JSON string representation of an entity.
 */
export function toCanonicalJson(entity) {
  if (entity === null || entity === undefined) return 'null';
  const canonicalObj = canonicalizeValue(entity);
  return JSON.stringify(canonicalObj);
}

/**
 * Asynchronously computes the 64-character lowercase hexadecimal SHA-256
 * digest of an entity using Web Crypto API (SubtleCrypto).
 */
export async function computeCanonicalSha256(entity) {
  if (entity === null || entity === undefined) return null;

  const jsonStr = toCanonicalJson(entity);
  const encoder = new TextEncoder();
  const data = encoder.encode(jsonStr);

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available in current runtime environment.');
  }

  const hashBuffer = await subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
