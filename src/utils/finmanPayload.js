/**
 * finmanPayload.js — Cross-Environment Transaction Synchronization Core Engine
 * 
 * Provides portable serialization, deserialization, validation, conflict classification,
 * companion linkage discovery, and in-memory sync planning for FinMan transactions.
 * 
 * DESIGN PRINCIPLE: COPY MUST BE FAITHFUL.
 * All persisted database representations, IDs, and financial metrics are preserved
 * exactly as recorded without recalculation or synthetic mutation.
 */

import { normaliseDateStr, getRowStableKey } from '../database/transactions.js';

export const FORMAT_IDENTIFIER = 'finman-transactions';
export const CURRENT_PAYLOAD_VERSION = 1;
export const SUPPORTED_PAYLOAD_VERSIONS = [1];

export const SYNC_ERROR_CODES = {
  EMPTY_INPUT: 'EMPTY_INPUT',
  INVALID_FORMAT: 'INVALID_FORMAT',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  COUNT_MISMATCH: 'COUNT_MISMATCH',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  INVALID_TRANSACTION: 'INVALID_TRANSACTION'
};

export const CLASSIFICATION_TYPES = {
  NEW: 'NEW',
  EXACT_EXISTING: 'EXACT_EXISTING',
  CONFLICT: 'CONFLICT',
  INVALID: 'INVALID'
};

export const RESOLUTION_ACTIONS = {
  INSERT: 'INSERT',
  REPLACE_WITH_INCOMING: 'REPLACE_WITH_INCOMING',
  KEEP_EXISTING: 'KEEP_EXISTING',
  SKIP: 'SKIP'
};

/**
 * Deterministic 64-bit checksum generator for payload validation
 */
export function computePayloadChecksum(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return '00000000';
  }

  // Canonical representation for checksum stability
  const canonicalStrings = transactions.map(t => {
    const id = String(t.id || t.ID || t._id || '');
    const date = normaliseDateStr(t.Date || t.date || '');
    const time = String(t.Time || t.time || '').trim();
    const acct = String(t.Account || t.account || '').trim();
    const toAcct = String(t.ToAccount || t.to_account || '').trim();
    const cat = String(t.Category || t.category || '').trim();
    const subcat = String(t.Subcategory || t.subcategory || '').trim();
    const note = String(t.Note || t.note || '').trim();
    const desc = String(t.Description || t.description || '').trim();
    const inr = parseFloat(t.INR || t.Amount || t.inr || t.amount || 0).toFixed(2);
    const type = String(t['Income/Expense'] || t.type || '').trim();
    const subAcct = String(t.SubAccount || t.sub_account || '').trim();
    const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim();
    const isin = String(t.SecurityISIN || t.security_isin || '').trim();
    const qty = parseFloat(t.Quantity || t.quantity || 0).toFixed(4);
    const price = parseFloat(t.UnitPrice || t.unit_price || 0).toFixed(4);
    const splitGroup = String(t.split_group_id || '').trim();

    return `${id}:${date}:${time}:${acct}:${toAcct}:${cat}:${subcat}:${note}:${desc}:${inr}:${type}:${subAcct}:${invType}:${isin}:${qty}:${price}:${splitGroup}`;
  });

  canonicalStrings.sort();
  const joined = canonicalStrings.join('||');

  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (h2 >>> 0) + (h1 >>> 0);
  return n.toString(16).padStart(8, '0');
}

/**
 * Phase 2 — Serialize one or multiple transactions into a portable, versioned payload string.
 * Preserves complete persisted transaction schema.
 */
export function serializeTransactions(transactionsInput, metadata = {}) {
  const rawArray = Array.isArray(transactionsInput) 
    ? transactionsInput 
    : (transactionsInput ? [transactionsInput] : []);

  if (rawArray.length === 0) {
    throw new Error('Cannot serialize empty transaction list.');
  }

  // Deep clone to prevent any input mutation and normalize property naming
  const clonedTransactions = rawArray.map(t => {
    const copy = { ...t };
    // Ensure primary ID is preserved
    const id = copy.id || copy.ID || copy._id;
    if (id) {
      copy.ID = id;
      copy._id = id;
      copy.id = id;
    }
    return copy;
  });

  const count = clonedTransactions.length;
  const checksum = computePayloadChecksum(clonedTransactions);

  const envelope = {
    format: FORMAT_IDENTIFIER,
    version: CURRENT_PAYLOAD_VERSION,
    exportedAt: metadata.exportedAt || new Date().toISOString(),
    source: metadata.source || 'FinMan',
    count,
    checksum,
    transactions: clonedTransactions
  };

  return JSON.stringify(envelope, null, 2);
}

/**
 * Phase 3 — Deserialize and validate a portable FinMan payload string.
 * Returns structured result object without throwing unhandled exceptions.
 */
export function parseFinmanPayload(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return {
      success: false,
      error: {
        code: SYNC_ERROR_CODES.EMPTY_INPUT,
        message: 'Payload text is empty.'
      }
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch (initialErr) {
    // Fallback: sanitize messaging artifacts (e.g. chat clients converting quotes to smart quotes)
    try {
      const sanitized = text
        .trim()
        .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
      parsed = JSON.parse(sanitized);
    } catch (parseErr) {
      return {
        success: false,
        error: {
          code: SYNC_ERROR_CODES.INVALID_FORMAT,
          message: `JSON parse error: ${initialErr.message}`
        }
      };
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      success: false,
      error: {
        code: SYNC_ERROR_CODES.INVALID_PAYLOAD,
        message: 'Payload root must be an object.'
      }
    };
  }

  if (parsed.format !== FORMAT_IDENTIFIER) {
    return {
      success: false,
      error: {
        code: SYNC_ERROR_CODES.INVALID_FORMAT,
        message: `Invalid format identifier. Expected '${FORMAT_IDENTIFIER}', got '${parsed.format}'.`
      }
    };
  }

  if (!SUPPORTED_PAYLOAD_VERSIONS.includes(parsed.version)) {
    return {
      success: false,
      error: {
        code: SYNC_ERROR_CODES.UNSUPPORTED_VERSION,
        message: `Unsupported payload version ${parsed.version}. Supported versions: ${SUPPORTED_PAYLOAD_VERSIONS.join(', ')}.`
      }
    };
  }

  if (!Array.isArray(parsed.transactions)) {
    return {
      success: false,
      error: {
        code: SYNC_ERROR_CODES.INVALID_PAYLOAD,
        message: 'Payload missing transactions array.'
      }
    };
  }

  if (typeof parsed.count === 'number' && parsed.transactions.length !== parsed.count) {
    return {
      success: false,
      error: {
        code: SYNC_ERROR_CODES.COUNT_MISMATCH,
        message: `Transaction count mismatch: declared ${parsed.count}, found ${parsed.transactions.length}.`
      }
    };
  }

  // Validate checksum if provided
  if (parsed.checksum) {
    const computed = computePayloadChecksum(parsed.transactions);
    if (computed !== parsed.checksum) {
      return {
        success: false,
        error: {
          code: SYNC_ERROR_CODES.CHECKSUM_MISMATCH,
          message: `Integrity checksum mismatch: expected '${parsed.checksum}', computed '${computed}'.`
        }
      };
    }
  }

  // Validate individual transactions
  for (let i = 0; i < parsed.transactions.length; i++) {
    const t = parsed.transactions[i];
    if (!t || typeof t !== 'object') {
      return {
        success: false,
        error: {
          code: SYNC_ERROR_CODES.INVALID_TRANSACTION,
          message: `Transaction at index ${i} is not a valid object.`,
          index: i
        }
      };
    }

    const id = t.id || t.ID || t._id;
    const rawDate = t.Date || t.date;
    const dateVal = normaliseDateStr(rawDate);

    if (!id) {
      return {
        success: false,
        error: {
          code: SYNC_ERROR_CODES.INVALID_TRANSACTION,
          message: `Transaction at index ${i} is missing unique identity ID.`,
          index: i
        }
      };
    }

    if (!dateVal || !/^\d{2}\/\d{2}\/\d{4}$/.test(dateVal)) {
      return {
        success: false,
        error: {
          code: SYNC_ERROR_CODES.INVALID_TRANSACTION,
          message: `Transaction at index ${i} ('${id}') has invalid date format: '${rawDate}'.`,
          index: i,
          id
        }
      };
    }
  }

  return {
    success: true,
    transactions: parsed.transactions,
    payload: {
      format: parsed.format,
      version: parsed.version,
      exportedAt: parsed.exportedAt,
      source: parsed.source,
      count: parsed.transactions.length,
      checksum: parsed.checksum || computePayloadChecksum(parsed.transactions),
      transactions: parsed.transactions
    }
  };
}

/**
 * Phase 5 — Discover and bundle related transactions (e.g. BUY + linked statutory CHARGE row, split legs).
 */
export function bundleRelatedTransactions(selectedTransactions, allTransactionsPool) {
  const selectedArr = Array.isArray(selectedTransactions) 
    ? selectedTransactions 
    : (selectedTransactions ? [selectedTransactions] : []);

  const allPool = Array.isArray(allTransactionsPool) ? allTransactionsPool : [];
  
  if (selectedArr.length === 0) {
    return {
      selectedCount: 0,
      linkedCount: 0,
      totalCount: 0,
      transactions: [],
      linkageMap: {}
    };
  }

  const selectedIdSet = new Set(selectedArr.map(t => String(t.id || t.ID || t._id)));
  const linkedItemsMap = new Map();
  const linkageMap = {};

  for (const sel of selectedArr) {
    const selId = String(sel.id || sel.ID || sel._id);
    const relatedForThis = [];

    // 1. Linked investment charges (split_group_id === 'inv_charge_' + selId)
    const expectedChargeGroupId = `inv_charge_${selId}`;
    for (const cand of allPool) {
      const candId = String(cand.id || cand.ID || cand._id);
      if (selectedIdSet.has(candId)) continue; // Already explicitly selected

      if (cand.split_group_id === expectedChargeGroupId) {
        if (!linkedItemsMap.has(candId)) {
          linkedItemsMap.set(candId, cand);
          relatedForThis.push({
            type: 'INVESTMENT_CHARGE',
            parentId: selId,
            transaction: cand
          });
        }
      }
    }

    // 2. Split group sibling legs (if sel.split_group_id is populated and not an inv_charge)
    if (sel.split_group_id && !sel.split_group_id.startsWith('inv_charge_')) {
      for (const cand of allPool) {
        const candId = String(cand.id || cand.ID || cand._id);
        if (selectedIdSet.has(candId)) continue;

        if (cand.split_group_id === sel.split_group_id) {
          if (!linkedItemsMap.has(candId)) {
            linkedItemsMap.set(candId, cand);
            relatedForThis.push({
              type: 'SPLIT_LEG',
              parentId: selId,
              transaction: cand
            });
          }
        }
      }
    }

    if (relatedForThis.length > 0) {
      linkageMap[selId] = relatedForThis;
    }
  }

  const bundled = [...selectedArr, ...Array.from(linkedItemsMap.values())];

  return {
    selectedCount: selectedArr.length,
    linkedCount: linkedItemsMap.size,
    totalCount: bundled.length,
    transactions: bundled,
    linkageMap
  };
}

/**
 * Phase 4 — Determine differences between incoming and existing transaction
 */
function findTransactionDifferences(incoming, existing) {
  const diffs = [];
  const fieldsToCheck = [
    { key: 'Date', altKey: 'date', label: 'Date' },
    { key: 'Time', altKey: 'time', label: 'Time' },
    { key: 'Account', altKey: 'account', label: 'Account' },
    { key: 'FromAccount', altKey: 'from_account', label: 'From Account' },
    { key: 'ToAccount', altKey: 'to_account', label: 'To Account' },
    { key: 'Category', altKey: 'category', label: 'Category' },
    { key: 'Subcategory', altKey: 'subcategory', label: 'Subcategory' },
    { key: 'Note', altKey: 'note', label: 'Note' },
    { key: 'Description', altKey: 'description', label: 'Description' },
    { key: 'Amount', altKey: 'amount', isAmount: true, label: 'Amount' },
    { key: 'INR', altKey: 'inr', isNumeric: true, label: 'INR' },
    { key: 'Income/Expense', altKey: 'type', label: 'Type' },
    { key: 'SubAccount', altKey: 'sub_account', label: 'SubAccount' },
    { key: 'InvestmentTransactionType', altKey: 'investment_transaction_type', label: 'Inv Type' },
    { key: 'SecurityISIN', altKey: 'security_isin', label: 'ISIN' },
    { key: 'Quantity', altKey: 'quantity', isNumeric: true, label: 'Quantity' },
    { key: 'UnitPrice', altKey: 'unit_price', isNumeric: true, label: 'Unit Price' },
    { key: 'TotalCharges', altKey: 'total_charges', isNumeric: true, label: 'Total Charges' }
  ];

  for (const field of fieldsToCheck) {
    const valIn = incoming[field.key] !== undefined ? incoming[field.key] : incoming[field.altKey];
    const valEx = existing[field.key] !== undefined ? existing[field.key] : existing[field.altKey];

    if (field.isNumeric) {
      const numIn = parseFloat(valIn || 0);
      const numEx = parseFloat(valEx || 0);
      if (Math.abs(numIn - numEx) > 0.0001) {
        diffs.push({ field: field.label, incoming: numIn, existing: numEx });
      }
    } else if (field.isAmount) {
      const strIn = String(valIn ?? '').trim();
      const strEx = String(valEx ?? '').trim();
      if (strIn !== strEx && parseFloat(strIn || 0) !== parseFloat(strEx || 0)) {
        diffs.push({ field: field.label, incoming: strIn, existing: strEx });
      }
    } else {
      const strIn = String(valIn ?? '').trim();
      const strEx = String(valEx ?? '').trim();
      if (strIn !== strEx) {
        diffs.push({ field: field.label, incoming: strIn, existing: strEx });
      }
    }
  }

  return diffs;
}

/**
 * Phase 4 — Classify incoming transaction against destination database state
 */
export function classifyTransaction(incomingTxn, existingIdMap, existingStableKeyMap) {
  const incomingId = String(incomingTxn.id || incomingTxn.ID || incomingTxn._id || '');
  const rawDate = incomingTxn.Date || incomingTxn.date;
  const dateVal = normaliseDateStr(rawDate);

  if (!incomingId || !dateVal) {
    return {
      classification: CLASSIFICATION_TYPES.INVALID,
      reason: 'Missing ID or valid Date',
      diffFields: [],
      incomingTxn,
      existingTxn: null
    };
  }

  const rawAcct = String(incomingTxn.Account || incomingTxn.account || '').trim();
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
  const acctName = looksNumeric(rawAcct)
    ? String(incomingTxn.FromAccount || incomingTxn.from_account || rawAcct).trim()
    : rawAcct;

  const incomingStableKey = getRowStableKey(incomingTxn, dateVal, acctName);

  // 1. Check ID Match (Tier 1)
  const existingById = existingIdMap.get(incomingId);
  if (existingById) {
    const diffs = findTransactionDifferences(incomingTxn, existingById);
    if (diffs.length === 0) {
      return {
        classification: CLASSIFICATION_TYPES.EXACT_EXISTING,
        matchType: 'ID_AND_DATA_MATCH',
        reason: 'Identical transaction ID and data already present in database.',
        diffFields: [],
        incomingTxn,
        existingTxn: existingById
      };
    } else {
      return {
        classification: CLASSIFICATION_TYPES.CONFLICT,
        matchType: 'ID_MATCH_DATA_DIFFERS',
        reason: `Transaction ID '${incomingId}' exists with different field values.`,
        diffFields: diffs,
        incomingTxn,
        existingTxn: existingById
      };
    }
  }

  // 2. Check Stable Key Match (Tier 2)
  const existingByStableKey = existingStableKeyMap.get(incomingStableKey);
  if (existingByStableKey) {
    const existingKeyId = String(existingByStableKey.id || existingByStableKey.ID || existingByStableKey._id || '');
    if (existingKeyId === incomingId) {
      return {
        classification: CLASSIFICATION_TYPES.EXACT_EXISTING,
        matchType: 'KEY_MATCH_IDENTICAL',
        reason: 'Identical business key and matching ID present in database.',
        diffFields: [],
        incomingTxn,
        existingTxn: existingByStableKey
      };
    } else {
      return {
        classification: CLASSIFICATION_TYPES.CONFLICT,
        matchType: 'KEY_MATCH_ID_DIFFERS',
        reason: `Business content key matches existing record '${existingKeyId}' but has different ID '${incomingId}'.`,
        diffFields: [{ field: 'ID', incoming: incomingId, existing: existingKeyId }],
        incomingTxn,
        existingTxn: existingByStableKey
      };
    }
  }

  // 3. Brand New Transaction
  return {
    classification: CLASSIFICATION_TYPES.NEW,
    matchType: 'NO_MATCH',
    reason: 'New transaction (no matching ID or business key found).',
    diffFields: [],
    incomingTxn,
    existingTxn: null
  };
}

/**
 * Phase 6 & 7 — Build in-memory sync plan with missing reference detection.
 * Pure computation — does NOT mutate destination database.
 */
export function createSyncPlan({
  incomingTransactions,
  existingTransactions = [],
  existingAccounts = [],
  existingCategories = {}
}) {
  const incomingArr = Array.isArray(incomingTransactions) ? incomingTransactions : [];
  const existingArr = Array.isArray(existingTransactions) ? existingTransactions : [];

  // Build lookups for fast indexing
  const existingIdMap = new Map();
  const existingStableKeyMap = new Map();

  for (const ex of existingArr) {
    const id = String(ex.id || ex.ID || ex._id || '');
    if (id) existingIdMap.set(id, ex);

    const rawDate = ex.Date || ex.date;
    const dateVal = normaliseDateStr(rawDate);
    const rawAcct = String(ex.Account || ex.account || '').trim();
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
    const acctName = looksNumeric(rawAcct)
      ? String(ex.FromAccount || ex.from_account || rawAcct).trim()
      : rawAcct;

    if (dateVal && acctName) {
      const stableKey = getRowStableKey(ex, dateVal, acctName);
      if (!existingStableKeyMap.has(stableKey)) {
        existingStableKeyMap.set(stableKey, ex);
      }
    }
  }

  const existingAccountNames = new Set(
    (existingAccounts || []).map(a => (typeof a === 'string' ? a : a.name || '')).filter(Boolean)
  );

  const existingCategoryNames = new Set(
    Object.keys(existingCategories || {})
  );

  const newItems = [];
  const exactExistingItems = [];
  const conflictItems = [];
  const invalidItems = [];

  const missingAccountsSet = new Set();
  const missingCategoriesSet = new Set();
  const missingSubAccountsSet = new Set();

  const RESERVED_ACCT = new Set(['INR', 'USD', 'GBP', 'EUR', 'Transfer', 'Transfer-Out', 'Transfer-In']);
  const RESERVED_CAT = new Set(['Transfer', 'Transfer-Out', 'Transfer-In', 'Income', 'Expense']);

  for (const incoming of incomingArr) {
    const classified = classifyTransaction(incoming, existingIdMap, existingStableKeyMap);

    switch (classified.classification) {
      case CLASSIFICATION_TYPES.NEW:
        newItems.push(classified);
        break;
      case CLASSIFICATION_TYPES.EXACT_EXISTING:
        exactExistingItems.push(classified);
        break;
      case CLASSIFICATION_TYPES.CONFLICT:
        conflictItems.push(classified);
        break;
      default:
        invalidItems.push(classified);
        break;
    }

    // Reference Dependency Check
    const acct = String(incoming.Account || incoming.account || '').trim();
    const fromAcct = String(incoming.FromAccount || incoming.from_account || '').trim();
    const toAcct = String(incoming.ToAccount || incoming.to_account || '').trim();
    const cat = String(incoming.Category || incoming.category || '').trim();
    const subAcct = String(incoming.SubAccount || incoming.sub_account || incoming.Brokerage || incoming.brokerage || '').trim();

    [acct, fromAcct, toAcct].forEach(a => {
      if (a && !RESERVED_ACCT.has(a) && !existingAccountNames.has(a)) {
        missingAccountsSet.add(a);
      }
    });

    const isXfer = String(incoming['Income/Expense'] || incoming.type || '').toLowerCase().startsWith('transfer');
    if (!isXfer && cat && !RESERVED_CAT.has(cat) && !existingCategoryNames.has(cat)) {
      missingCategoriesSet.add(cat);
    }

    if (subAcct && acct && !RESERVED_ACCT.has(acct)) {
      missingSubAccountsSet.add(`${acct}::${subAcct}`);
    }
  }

  return {
    new: newItems,
    exactExisting: exactExistingItems,
    conflicts: conflictItems,
    invalid: invalidItems,
    missingReferences: {
      accounts: Array.from(missingAccountsSet).sort(),
      categories: Array.from(missingCategoriesSet).sort(),
      subAccounts: Array.from(missingSubAccountsSet).map(s => {
        const [account, subAccount] = s.split('::');
        return { account, subAccount };
      })
    },
    summary: {
      total: incomingArr.length,
      newCount: newItems.length,
      exactExistingCount: exactExistingItems.length,
      conflictCount: conflictItems.length,
      invalidCount: invalidItems.length
    }
  };
}

/**
 * Phase 8 & 9 — Prepare and execute the approved plan against the database.
 * Reuses existing bulkImport and single transaction update infrastructure.
 */
export async function executeSyncPlan(plan, resolutions = {}, dbContext = {}) {
  const { bulkImportFn, updateTransactionFn, addTransactionFn, registerReferencesFn } = dbContext;

  const toInsert = [];
  const toUpdate = [];
  let skippedCount = 0;

  // 1. Process NEW items (default: INSERT)
  for (const item of plan.new) {
    const id = String(item.incomingTxn.id || item.incomingTxn.ID || item.incomingTxn._id);
    const userChoice = resolutions[id] || RESOLUTION_ACTIONS.INSERT;
    if (userChoice === RESOLUTION_ACTIONS.INSERT) {
      toInsert.push(item.incomingTxn);
    } else {
      skippedCount++;
    }
  }

  // 2. Process EXACT_EXISTING items (default: SKIP)
  for (const item of plan.exactExisting) {
    const id = String(item.incomingTxn.id || item.incomingTxn.ID || item.incomingTxn._id);
    const userChoice = resolutions[id] || RESOLUTION_ACTIONS.SKIP;
    if (userChoice === RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING) {
      toUpdate.push(item.incomingTxn);
    } else {
      skippedCount++;
    }
  }

  // 3. Process CONFLICT items (default: SKIP / KEEP_EXISTING unless explicitly REPLACE_WITH_INCOMING)
  for (const item of plan.conflicts) {
    const id = String(item.incomingTxn.id || item.incomingTxn.ID || item.incomingTxn._id);
    const userChoice = resolutions[id] || RESOLUTION_ACTIONS.KEEP_EXISTING;
    if (userChoice === RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING) {
      toUpdate.push(item.incomingTxn);
    } else {
      skippedCount++;
    }
  }

  // 4. Auto-register missing reference entities if callback provided
  if (typeof registerReferencesFn === 'function' && plan.missingReferences) {
    await registerReferencesFn(plan.missingReferences);
  }

  let insertedCount = 0;
  let updatedCount = 0;

  // 5. Perform batch inserts for new items
  if (toInsert.length > 0) {
    if (typeof bulkImportFn === 'function') {
      const res = await bulkImportFn(toInsert, { firstImport: false });
      insertedCount += (res.imported || toInsert.length);
    } else if (typeof addTransactionFn === 'function') {
      for (const t of toInsert) {
        await addTransactionFn(t);
        insertedCount++;
      }
    }
  }

  // 6. Perform updates for approved replacements
  if (toUpdate.length > 0 && typeof updateTransactionFn === 'function') {
    for (const t of toUpdate) {
      const id = String(t.id || t.ID || t._id);
      await updateTransactionFn(id, t);
      updatedCount++;
    }
  }

  return {
    success: true,
    insertedCount,
    updatedCount,
    skippedCount,
    totalProcessed: insertedCount + updatedCount + skippedCount
  };
}
